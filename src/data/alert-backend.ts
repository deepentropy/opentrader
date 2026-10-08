/*
 * Alert rules evaluated by the backend.
 *
 * A rule that compares the price with a fixed value or with a drawing's
 * levels needs nothing the window alone can compute, so the backend
 * evaluates it on every quote it receives (src-tauri/src/alerts.rs). This
 * module is the window's side of it:
 *  - one window runs the alerts (`whenAlertLeader`): the first one to ask,
 *    another one when it is closed;
 *  - that window compiles each rule into what the backend reads: the bars of
 *    the rule's interval (sessions included) and the drawing's values on
 *    each of them. A sloped line is straight over the bars, not over the
 *    calendar, so its level skips the hours without bars as on the chart;
 *  - it delivers the fires the backend sends back, the offline ones (found
 *    in the bars missed while the app was not running) to the log and the
 *    rule's webhook only.
 *
 * Rules on an indicator, an anchored VWAP or a moving percentage stay in the
 * window's engine (alert-engine.ts).
 */
import { createEffect, createRoot } from "solid-js";
import { listen } from "@tauri-apps/api/event";
import type { Drawing } from "lightweight-charts-drawing/core/types";
import { commands, type AlertFired, type AlertLeader, type EngineGrid, type EngineRule } from "../bindings";
import { alertStore, type AlertRule } from "./alert-store";
import { drawingValues, isBandOperator, isPercentOperator, LEVEL_OPERATORS, type TimeAxis } from "./alert-condition";
import { cachedSymbolSessions, localDay, localToUtc, sessionsVersion, type SymbolSessions } from "./session";
import { periodStart } from "../window/chart/chart-aggregate";
import { loadDrawings } from "../window/drawings/persistence";

const HAS_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** True when the backend evaluates the rule (the window's engine skips it). */
export function evaluatedByBackend(rule: AlertRule): boolean {
  if (!HAS_TAURI || rule.left.kind !== "price" || isPercentOperator(rule.op)) return false;
  if (rule.right.kind === "value") return LEVEL_OPERATORS.includes(rule.op);
  return rule.right.kind === "drawing" && rule.right.plot == null;
}

/** Run `start` in the window that runs the alerts: at once when this window
 *  is the one, later when it takes over from a closed one. Outside the app
 *  shell (no backend) the main window is the one. */
export function whenAlertLeader(windowLabel: string, start: () => void): void {
  if (!HAS_TAURI) {
    if (windowLabel === "main") start();
    return;
  }
  void listen<AlertLeader>("alert-leader", (e) => {
    if (e.payload.window === windowLabel) start();
  });
  void commands.alertEngineClaim().then((mine) => {
    if (mine) start();
  });
}

// ── Bars of an interval ──

type Bars = [number, number][];
type Interval = { unit: string; n: number; stepSec: number };

function parseInterval(res: string): Interval | null {
  const m = /^(\d*)\s*([a-zA-Z]?)$/.exec(res.trim());
  if (!m) return null;
  const n = Number(m[1] || 1);
  const unit = m[2] === "d" ? "D" : m[2] === "w" ? "W" : m[2] === "h" ? "H" : m[2] === "s" ? "S" : m[2];
  const sec = unit === "S" ? 1 : unit === "H" ? 3600 : unit === "D" ? 86400 : unit === "W" ? 604800 : unit === "M" ? 2592000 : 60;
  return n > 0 ? { unit, n, stepSec: n * sec } : null;
}

const isDaily = (iv: Interval) => iv.unit === "D" || iv.unit === "W" || iv.unit === "M";

/** Bars [open, close] of `iv` that close after `from` and open before `to`
 *  (UNIX seconds), as the engine buckets them: intraday bars anchored at the
 *  start of each extended-session interval, the last one cut at its end;
 *  daily / weekly / monthly bars from their stamp to the close of their last
 *  trading day. */
function barsBetween(sessions: SymbolSessions, iv: Interval, from: number, to: number): Bars {
  const out: Bars = [];
  const tz = sessions.timeZone;
  if (isDaily(iv)) {
    const period = iv.unit === "W" ? "week" : iv.unit === "M" ? "month" : "day";
    // The period holding `to` is followed to its last trading day.
    for (let day = localDay(tz, from) - 1, guard = 0; guard < 4000; day++, guard++) {
      const bounds = sessions.regular.dayBounds(day);
      if (!bounds) continue;
      const stamp = localToUtc(tz, day, 0);
      const open = period === "day" && iv.n === 1 ? stamp : periodStart(stamp, { unit: period, n: iv.n }, sessions.regular);
      const last = out[out.length - 1];
      if (last && last[0] === open) last[1] = bounds.end;
      else if (last && last[0] >= to) break;
      else out.push([open, bounds.end]);
    }
    if (out.length > 0 && out[out.length - 1][0] >= to) out.pop();
    return out.filter((b) => b[1] > from);
  }
  for (let day = localDay(tz, from) - 2, end = localDay(tz, to) + 2; day <= end; day++) {
    for (const s of sessions.extended.dayIntervals(day)) {
      if (s.end <= from) continue;
      for (let open = s.start; open < s.end && open < to; open += iv.stepSec) {
        const close = Math.min(open + iv.stepSec, s.end);
        if (close > from) out.push([open, close]);
      }
    }
  }
  return out;
}

// ── Compilation ──

/** Bars ahead of now handed over each time, and how often they are renewed. */
const AHEAD_SEC = 5 * 86400;
const AHEAD_BARS = 5000;
const RENEW_MS = 10 * 60_000;
/** Oldest bars handed over (the backend replays no further back). */
const BACK_SEC = 30 * 86400;
const BACK_BARS = 50_000;
/** Longest bar axis built for a sloped line; a line whose points are further
 *  apart is followed over the calendar time instead. */
const AXIS_BARS = 400_000;

/** Bar index of a time: the axis a sloped line is straight on. */
function barAxis(bars: Bars): TimeAxis {
  return (t) => {
    let lo = 0;
    let hi = bars.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (bars[mid][1] <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
}

/** Kinds whose level changes from bar to bar. */
const SLOPED_KINDS = new Set(["trend-line", "ray", "extended-line", "parallel-channel", "disjoint-channel", "flat-top-bottom"]);

/** The axis of `d`'s lines: the bars from its earliest point to the end of
 *  the grid. Undefined (calendar time) for a flat drawing or a span too long. */
function axisOf(d: Drawing, sessions: SymbolSessions, iv: Interval, gridFrom: number, gridTo: number): TimeAxis | undefined {
  if (!SLOPED_KINDS.has(d.kind)) return undefined;
  const times = d.points.flatMap((p) => (typeof p.time === "number" ? [p.time as number] : []));
  if (times.length < 2) return undefined;
  const from = Math.min(gridFrom, ...times) - 1;
  const to = Math.max(gridTo, ...times) + 1;
  if ((to - from) / iv.stepSec > AXIS_BARS) return undefined;
  return barAxis(barsBetween(sessions, iv, from, to));
}

const sameValues = (a: number[], b: number[]) => a.length === b.length && a.every((v, i) => v === b[i]);

type Compiled = { rules: EngineRule[]; grids: EngineGrid[]; key: string };

/** Grid keys already handed over once with the bars since the previous run. */
const covered = new Set<string>();
/** Time of each symbol's last quote in the previous run (UNIX seconds). */
let previousRun: Record<string, number | null> = {};

/** The enabled backend rules as the backend takes them, with the bars of
 *  their intervals. `key` changes when anything handed over would. */
export function compileBackendRules(nowSec: number, epoch: number): Compiled {
  const rules: EngineRule[] = [];
  const grids = new Map<string, EngineGrid & { from: number; to: number }>();
  const keys: string[] = [];
  const enabled = alertStore.enabledRules().filter(evaluatedByBackend);
  for (const rule of enabled) {
    const iv = parseInterval(rule.resolution);
    const sessions = cachedSymbolSessions(rule.symbol);
    if (!iv || !sessions) continue;
    const right = rule.right;
    const drawing = right.kind === "drawing" ? loadDrawings(rule.symbol).find((d) => d.id === right.drawingId) : undefined;
    if (right.kind === "drawing" && !drawing) continue;
    const since = rule.activeSince ?? rule.createdAt;

    const gridKey = `${rule.symbol}|${rule.resolution}`;
    let grid = grids.get(gridKey);
    if (!grid) {
      // The first time, the bars go back to the previous run (what the
      // backend replays); afterwards the current bar is enough.
      const symbolRules = enabled.filter((r) => r.symbol === rule.symbol);
      const oldest = Math.min(...symbolRules.map((r) => r.activeSince ?? r.createdAt)) / 1000;
      const back = covered.has(gridKey) ? nowSec : Math.max(nowSec - BACK_SEC, previousRun[rule.symbol] ?? oldest);
      const from = Math.max(Math.min(back, nowSec) - iv.stepSec, nowSec - BACK_BARS * iv.stepSec);
      // Always up to the next bar to open, so the last bar of a session can
      // be seen closing.
      const next = (isDaily(iv) ? sessions.regular : sessions.extended).currentOrNext(nowSec)?.start ?? nowSec;
      const to = Math.max(nowSec + Math.min(AHEAD_SEC, AHEAD_BARS * iv.stepSec), next + 2 * iv.stepSec);
      const regular: Bars = [];
      for (let day = localDay(sessions.timeZone, from) - 1, end = localDay(sessions.timeZone, nowSec) + 1; day <= end; day++) {
        for (const s of sessions.regular.dayIntervals(day)) regular.push([s.start, s.end]);
      }
      grids.set(gridKey, (grid = { key: gridKey, bars: barsBetween(sessions, iv, from, to), regular, from, to }));
    }

    const sig = JSON.stringify([rule.op, right, rule.frequency, rule.resolution, since, drawing?.points, drawing?.style]);
    const compiled: EngineRule = {
      id: rule.id,
      symbol: rule.symbol,
      sig,
      op: rule.op,
      shape: "level",
      frequency: rule.frequency,
      expiresAt: rule.expiresAt,
      since,
      grid: gridKey,
      values: [],
      perBar: null,
      absentIsOutside: false,
    };
    if (right.kind === "value") {
      compiled.values = [right.value];
    } else if (right.kind === "drawing" && drawing) {
      compiled.shape = right.band === "time" ? "time" : right.band === "position" ? "position" : isBandOperator(rule.op) || right.band === "rectangle" ? "band" : "level";
      compiled.absentIsOutside = right.band === "rectangle";
      const axis = axisOf(drawing, sessions, iv, grid.from, grid.to);
      const perBar = (grid.bars as Bars).map(([open]) => drawingValues(drawing, right, rule.op, open, axis, sessions.mintick) ?? []);
      // The same values on every bar: one entry is enough.
      if (perBar.length > 0 && perBar.every((v) => sameValues(v, perBar[0]))) compiled.values = perBar[0];
      else compiled.perBar = perBar;
    }
    rules.push(compiled);
    keys.push(`${rule.id}\u0001${sig}\u0001${rule.expiresAt}`);
  }
  for (const k of grids.keys()) covered.add(k);
  return { rules, grids: [...grids.values()].map(({ key, bars, regular }) => ({ key, bars, regular })), key: `${epoch}\u0002${keys.join("\u0002")}` };
}

// ── Sync with the backend ──

/** A fire to deliver: the rule, the price it fired at, the bar it fired in
 *  (UNIX ms) and, for an offline fire, when it happened. */
export type BackendFire = { rule: AlertRule; price: number; barTime: number | null; offline: boolean; fireTime: number };

let started = false;
let lastKey: string | null = null;

function sync(): void {
  const now = Date.now();
  const { rules, grids, key } = compileBackendRules(Math.floor(now / 1000), Math.floor(now / RENEW_MS));
  if (key === lastKey) return;
  lastKey = key;
  void commands.alertEngineSet(rules, grids).catch((e) => {
    lastKey = null;
    console.warn("[alerts] rules not handed to the backend", e);
  });
}

/** Hand the backend its rules and keep them current; `deliver` receives its
 *  fires. Call in the window that runs the alerts. Idempotent. */
export function startAlertBackend(deliver: (fire: BackendFire) => void, windowLabel: string): void {
  if (!HAS_TAURI || started) return;
  started = true;

  void listen<AlertFired>("alert-fired", (e) => {
    const f = e.payload;
    if (f.window !== windowLabel || f.price == null || f.time == null) return;
    const rule = alertStore.rule(f.ruleId);
    if (!rule || !rule.enabled) return;
    deliver({
      rule,
      price: f.price,
      barTime: f.barTime == null ? null : f.barTime * 1000,
      offline: f.offline,
      fireTime: f.offline ? f.time * 1000 : Date.now(),
    });
  });

  void commands.alertEngineInfo().then((info) => {
    previousRun = info.previous;
    createRoot(() => {
      // Rules and sessions are tracked; a moved drawing is caught by the
      // timer (its storage has no signal in the window that writes it).
      createEffect(() => {
        alertStore.rules().forEach((r) => [r.enabled, r.op, r.frequency, r.expiresAt, r.activeSince, JSON.stringify(r.right)]);
        sessionsVersion();
        sync();
      });
    });
    setInterval(sync, 5000);
  });
}
