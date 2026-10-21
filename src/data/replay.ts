/*
 * Bar Replay: the state shared by the header button, the replay toolbar and
 * the charts (one replay per window).
 *
 * The reference app runs replay on its servers (a session that steps a cursor
 * over the bars); here every chart pane replays its own loaded bars and
 * registers a handle, and this module is the cursor: it picks the start point,
 * steps all the panes in replay to the next update time, plays on a timer and
 * stops at the end of the data.
 *
 * States: off (no toolbar) → open (toolbar, no point) → selecting (the chart
 * picks a bar) → paused / playing (charts cut at the replay time).
 */
import { createSignal } from "solid-js";
import * as kv from "./kv";
import type { WallDate, WallTime } from "../window/chart/day-key";

/** Which charts a replay covers (the header "Replay mode" menu). */
export type ReplayMode = "ActiveChart" | "AllCharts";
/** How the start point is picked (the toolbar split button). */
export type TimingMode = "bar" | "date" | "first" | "random";

/** Autoplay speeds: label, delay between updates (ms), menu description. */
export const REPLAY_SPEEDS: readonly { label: string; delay: number; desc: string }[] = [
  { label: "10x", delay: 100, desc: "10 upd per 1 sec" },
  { label: "7x", delay: 143, desc: "7 upd per 1 sec" },
  { label: "5x", delay: 200, desc: "5 upd per 1 sec" },
  { label: "3x", delay: 300, desc: "3 upd per 1 sec" },
  { label: "1x", delay: 1000, desc: "1 upd per 1 sec" },
  { label: "0.5x", delay: 2000, desc: "1 upd per 2 sec" },
  { label: "0.3x", delay: 3000, desc: "1 upd per 3 sec" },
  { label: "0.2x", delay: 5000, desc: "1 upd per 5 sec" },
  { label: "0.1x", delay: 10000, desc: "1 upd per 10 sec" },
];
export const DEFAULT_REPLAY_DELAY = 1000;

const MODE_KEY = "ot:replay-mode";
const TIMING_KEY = "ot:replay-timing-mode";
const DELAY_KEY = "ot:replay-delay";

/** Nearest speed of a stored delay (an unknown value clamps to the closest). */
export function clampDelay(ms: number): number {
  let best = DEFAULT_REPLAY_DELAY;
  for (const s of REPLAY_SPEEDS) if (Math.abs(s.delay - ms) < Math.abs(best - ms)) best = s.delay;
  return best;
}

function readMode(): ReplayMode {
  return kv.getItem(MODE_KEY) === "AllCharts" ? "AllCharts" : "ActiveChart";
}
function readTiming(): TimingMode {
  const v = kv.getItem(TIMING_KEY);
  return v === "date" || v === "first" || v === "random" ? v : "bar";
}
function readDelay(): number {
  const n = Number(kv.getItem(DELAY_KEY));
  return Number.isFinite(n) && n > 0 ? clampDelay(n) : DEFAULT_REPLAY_DELAY;
}

// ── Update intervals ─────────────────────────────────────────────────────────

/** Seconds of an interval id ("1S", "5", "60", "1D", "1W", "1M"); a month
 *  counts 30 days (the reference app). */
export function replayIntervalSeconds(id: string): number {
  const m = /^(\d+)([SDWM])$/.exec(id);
  if (m) {
    const n = Number(m[1]);
    return n * ({ S: 1, D: 86400, W: 7 * 86400, M: 30 * 86400 } as const)[m[2] as "S" | "D" | "W" | "M"];
  }
  const n = Number(id);
  return Number.isFinite(n) ? n * 60 : NaN;
}

/** Candidate update intervals by chart interval kind (the reference app list, without
 *  ticks: the data has no trades). */
function candidatesFor(chart: string): string[] {
  if (/^\d+S$/.test(chart)) return ["1S", "5S", "10S", "15S", "30S", "45S"];
  if (/^\d+D$/.test(chart)) return ["60", "120", "180", "240", "1D"];
  if (/^\d+[WM]$/.test(chart)) return ["1D"];
  const mins = Number(chart);
  const small = ["1S", "1", "3", "5", "10", "15", "30", "45"];
  return mins >= 60 ? [...small, "60", "120", "180", "240"] : small;
}

/** The interval every chart steps on at least (the reference app common divisor):
 *  the chart interval itself, "1D" for a daily, weekly or monthly chart. */
function baseOf(chart: string): string {
  return /^\d+[DWM]$/.test(chart) ? "1D" : chart;
}

/** Update intervals offered for the charts in replay (`intervals`, one per
 *  chart, the first being the main one): the candidates of the main chart and
 *  its base interval, each no longer than the base and dividing every chart
 *  interval; ascending. `available(id)` drops those without data at the
 *  replay point. */
export function updateIntervals(intervals: string[], available: (id: string) => boolean = () => true): string[] {
  if (intervals.length === 0) return [];
  const main = intervals[0];
  const base = baseOf(main);
  const baseSec = replayIntervalSeconds(base);
  const divides = (id: string) => {
    const s = replayIntervalSeconds(id);
    return intervals.every((iv) => {
      if (/^\d+[WM]$/.test(iv)) return id === "1D";
      const t = replayIntervalSeconds(iv);
      return Number.isFinite(t) && t % s === 0;
    });
  };
  const all = [...new Set([...candidatesFor(main), base])].filter((id) => {
    const s = replayIntervalSeconds(id);
    return Number.isFinite(s) && s <= baseSec && divides(id);
  });
  all.sort((a, b) => replayIntervalSeconds(a) - replayIntervalSeconds(b));
  return all.filter(available);
}

/** The Auto update interval: the coarsest one offered (normally the chart
 *  interval itself), else the chart's base interval. */
export function autoUpdateInterval(list: string[], chart: string): string {
  return list.length > 0 ? list[list.length - 1] : baseOf(chart);
}

/** A fixed update interval no longer offered (the chart interval changed):
 *  the largest offered one shorter than it, else the first. */
export function fallbackUpdateInterval(list: string[], current: string): string | null {
  if (list.includes(current)) return current;
  const cur = replayIntervalSeconds(current);
  const shorter = list.filter((id) => replayIntervalSeconds(id) < cur);
  return shorter.length > 0 ? shorter[shorter.length - 1] : list[0] ?? null;
}

// ── Pane handles ─────────────────────────────────────────────────────────────

/** Why a chart cannot be replayed (the reference app "Caution!" hints), or null. */
export type ReplayUnavailable = "chartType" | "interval" | "symbol" | null;

/** What a chart pane gives the replay. */
export type ReplayPane = {
  paneId: number;
  /** The pane is on screen (its tab is shown). */
  shown: () => boolean;
  /** Chart interval id. */
  interval: () => string;
  /** Why it cannot be replayed now, or null. */
  unavailable: () => ReplayUnavailable;
  /** First time (s) with data on the chart interval, null while unknown. */
  firstAvailable: () => number | null;
  /** Earliest time (s) the data plan serves an interval. */
  depthOf: (interval: string) => number;
  /** Cut the chart at `point` (data after it hidden) on update interval
   *  `update`; false when there is no data at the point. */
  start: (point: number, update: string) => Promise<boolean>;
  /** Time of the next update after the replay time, null at the end of the
   *  data (loads ahead first). */
  next: () => Promise<number | null>;
  /** Show the data up to `time` (inclusive). */
  advanceTo: (time: number) => void;
  /** Back to the live chart. */
  stop: () => void;
  /** Daily, weekly or monthly chart (dates without a time). */
  dateOnly: () => boolean;
  /** A wall-clock date + time (minutes) in the chart's time zone, as UTC
   *  seconds (a date-only chart: the calendar date). */
  wallToTime: (date: WallDate, minutes: number) => number;
  /** UTC seconds as a wall-clock date + time of the chart. */
  timeToWall: (sec: number) => WallTime;
  /** A time inside a trading session of the chart's symbol. */
  inSession: (sec: number) => boolean;
};

const panes = new Map<number, ReplayPane>();

/** Register a chart pane; returns the unregister function. */
export function registerReplayPane(p: ReplayPane): () => void {
  panes.set(p.paneId, p);
  return () => {
    panes.delete(p.paneId);
    if (inReplay().includes(p.paneId)) setInReplay(inReplay().filter((id) => id !== p.paneId));
  };
}

// ── State ────────────────────────────────────────────────────────────────────

const [enabled, setEnabled] = createSignal(false);
const [selecting, setSelecting] = createSignal(false);
const [playing, setPlaying] = createSignal(false);
/** Panes cut at the replay time (empty = not started). */
const [inReplay, setInReplay] = createSignal<number[]>([]);
/** Replay time (s): the data shown ends at it. */
const [point, setPoint] = createSignal<number | null>(null);
const [mode, setModeSignal] = createSignal<ReplayMode>(readMode());
const [timing, setTimingSignal] = createSignal<TimingMode>(readTiming());
const [delay, setDelaySignal] = createSignal<number>(readDelay());
/** Fixed update interval; null = Auto. */
const [fixedUpdate, setFixedUpdate] = createSignal<string | null>(null);
const [dateDialog, setDateDialog] = createSignal(false);
/** The focused chart pane (the charts keep it current). */
const [activePane, setActivePane] = createSignal<number | null>(null);
/** Time under the pointer while selecting (All charts: every chart draws it). */
const [hoverTime, setHoverTime] = createSignal<number | null>(null);
/** Bumped when the data a pane in replay can serve changed (interval list). */
const [epoch, setEpoch] = createSignal(0);

export const replayEnabled = enabled;
export const replaySelecting = selecting;
export const replayPlaying = playing;
export const replayPanes = inReplay;
export const replayPoint = point;
export const replayMode = mode;
export const replayTiming = timing;
export const replayDelay = delay;
export const replayFixedUpdate = fixedUpdate;
export const replayDateDialog = dateDialog;
export const replaySelectHoverTime = hoverTime;
export const setReplaySelectHoverTime = setHoverTime;
export const replayActivePane = activePane;
export const setReplayActivePane = setActivePane;
export const replayEpoch = epoch;
export const bumpReplayEpoch = () => setEpoch((n) => n + 1);

/** Handle of the focused chart (the Select date dialog reads its time zone). */
export function activeReplayPane(): ReplayPane | null {
  const a = activePane();
  return a === null ? null : panes.get(a) ?? null;
}

/** The toolbar shows while replay is on and the focused chart can be
 *  replayed (a Renko chart hides it; replay mode stays on). */
export function replayToolbarShown(): boolean {
  if (!enabled()) return false;
  epoch();
  const p = activeReplayPane();
  return !p || p.unavailable() === null;
}

/** The replay has a point (charts cut). */
export const replayStarted = () => inReplay().length > 0;
/** A pane is cut at the replay time. */
export const isPaneInReplay = (paneId: number) => inReplay().includes(paneId);
/** The focused chart is in replay (Play / Forward / Jump are enabled). */
export const activeInReplay = () => {
  const a = activePane();
  return a !== null && inReplay().includes(a);
};

/** Panes a new replay covers: the focused chart (Single chart), or every
 *  shown chart that can be replayed (All charts). */
function targetPanes(clickedPane?: number): ReplayPane[] {
  const ok = (p: ReplayPane | undefined): p is ReplayPane => !!p && p.shown() && p.unavailable() === null;
  if (mode() === "AllCharts") return [...panes.values()].filter(ok);
  const id = clickedPane ?? activePane();
  const p = id !== null && id !== undefined ? panes.get(id) : undefined;
  return ok(p) ? [p] : [];
}

/** Charts the update interval list is built from: the panes in replay, else
 *  the ones a replay would cover. */
function intervalPanes(): ReplayPane[] {
  const ids = inReplay();
  if (ids.length > 0) return ids.map((id) => panes.get(id)).filter((p): p is ReplayPane => !!p);
  return targetPanes();
}

/** Update intervals offered now (the menu rows). */
export function replayUpdateIntervals(): string[] {
  epoch();
  const ps = intervalPanes();
  if (ps.length === 0) return [];
  const pt = point();
  const depth = (id: string) => Math.max(...ps.map((p) => p.depthOf(id)));
  return updateIntervals(
    ps.map((p) => p.interval()),
    (id) => pt === null || depth(id) <= pt,
  );
}

/** Update interval in use: the fixed one when still offered, else Auto. */
export function replayUpdateInterval(): string {
  const list = replayUpdateIntervals();
  const main = intervalPanes()[0]?.interval() ?? "1D";
  const fixed = fixedUpdate();
  if (fixed !== null) {
    const f = fallbackUpdateInterval(list, fixed);
    if (f !== null) return f;
  }
  return autoUpdateInterval(list, main);
}

/** Earliest time a replay can start on (the reference app depth): the latest first
 *  available time of the charts it covers, null while unknown. */
export function replayFirstAvailable(): number | null {
  epoch();
  const ps = intervalPanes();
  if (ps.length === 0) return null;
  let out = -Infinity;
  for (const p of ps) {
    const f = p.firstAvailable();
    if (f === null) return null;
    out = Math.max(out, f, p.depthOf(p.interval()));
  }
  return Number.isFinite(out) ? out : null;
}

// ── Autoplay ─────────────────────────────────────────────────────────────────

let timer: number | undefined;
let stepping = false;

function stopTimer() {
  if (timer !== undefined) window.clearInterval(timer);
  timer = undefined;
}
function startTimer() {
  stopTimer();
  timer = window.setInterval(() => {
    if (!stepping) void step();
  }, delay());
}

/** One update on every pane in replay: the earliest next update time across
 *  them; at the end of the data the replay stops (charts back to real time,
 *  toolbar kept). */
export async function step(): Promise<void> {
  if (!replayStarted() || stepping) return;
  stepping = true;
  try {
    const ps = inReplay().map((id) => panes.get(id)).filter((p): p is ReplayPane => !!p);
    const times = await Promise.all(ps.map((p) => p.next()));
    if (!replayStarted()) return;
    const valid = times.filter((t): t is number => t !== null);
    if (valid.length === 0) {
      stopReplay();
      return;
    }
    const t = Math.min(...valid);
    for (const p of ps) p.advanceTo(t);
    setPoint(t);
  } finally {
    stepping = false;
  }
}

export function setPlay(on: boolean) {
  if (on && !replayStarted()) return;
  setPlaying(on);
  if (on) startTimer();
  else stopTimer();
}

/** Play / Pause (Shift+↓): a selection in progress is cancelled first. */
export function togglePlay() {
  if (!replayStarted()) return;
  if (selecting()) setSelecting(false);
  setPlay(!playing());
}

export function setReplayDelay(ms: number) {
  const d = clampDelay(ms);
  setDelaySignal(d);
  kv.setItem(DELAY_KEY, String(d));
  // Playing: restart at the new speed.
  if (playing()) startTimer();
}

export function setReplayUpdateInterval(id: string | null) {
  setFixedUpdate(id);
  restartPanes();
}

// ── Start point ──────────────────────────────────────────────────────────────

/** Cut the panes at `pt` (seconds; the data shown ends at it). */
async function startAt(pt: number, clickedPane?: number): Promise<void> {
  const wasPlaying = playing();
  setPlay(false);
  setSelecting(false);
  // Single chart: a replay on another chart moves to this one.
  const targets = targetPanes(clickedPane);
  for (const id of inReplay()) if (!targets.some((p) => p.paneId === id)) panes.get(id)?.stop();
  if (targets.length === 0) {
    setInReplay([]);
    setPoint(null);
    return;
  }
  if (clickedPane !== undefined && mode() === "ActiveChart") setActivePane(clickedPane);
  setPoint(pt);
  // The update interval list depends on the replay point.
  setEpoch((n) => n + 1);
  const update = replayUpdateIntervalFor(targets, pt);
  const ok = await Promise.all(targets.map((p) => p.start(pt, update)));
  const started = targets.filter((_, i) => ok[i]);
  for (const p of targets) if (!started.includes(p)) p.stop();
  setInReplay(started.map((p) => p.paneId));
  if (started.length === 0) setPoint(null);
  void wasPlaying;
}

function replayUpdateIntervalFor(ps: ReplayPane[], pt: number): string {
  const depth = (id: string) => Math.max(...ps.map((p) => p.depthOf(id)));
  const list = updateIntervals(ps.map((p) => p.interval()), (id) => depth(id) <= pt);
  const fixed = fixedUpdate();
  if (fixed !== null) {
    const f = fallbackUpdateInterval(list, fixed);
    if (f !== null) return f;
  }
  return autoUpdateInterval(list, ps[0].interval());
}

/** Re-cut the panes in replay at the current point (update interval or
 *  chart data changed). Autoplay resumes after. */
function restartPanes() {
  const pt = point();
  if (pt === null || !replayStarted()) return;
  const wasPlaying = playing();
  setPlay(false);
  const ps = inReplay().map((id) => panes.get(id)).filter((p): p is ReplayPane => !!p);
  const update = replayUpdateIntervalFor(ps, pt);
  void Promise.all(ps.map((p) => p.start(pt, update))).then(() => {
    if (wasPlaying && replayStarted()) setPlay(true);
  });
}

/** A chart in replay loaded new data (interval, symbol, session, reload):
 *  it continues at the same replay time. */
export function replayPaneReloaded(paneId: number) {
  const pt = point();
  const p = panes.get(paneId);
  if (pt === null || !p || !inReplay().includes(paneId)) return;
  setEpoch((n) => n + 1);
  const update = replayUpdateIntervalFor([p], pt);
  void p.start(pt, update).then((ok) => {
    if (!ok) leavePane(paneId);
  });
}

/** A chart leaves the replay (its style can't be replayed, …); the replay
 *  stops when no chart is left. */
export function leavePane(paneId: number) {
  if (!inReplay().includes(paneId)) return;
  panes.get(paneId)?.stop();
  const rest = inReplay().filter((id) => id !== paneId);
  setInReplay(rest);
  if (rest.length === 0) {
    setPlay(false);
    setPoint(null);
  }
}

/** A bar was clicked while selecting: it becomes the first hidden bar. */
export function selectBar(paneId: number, barTime: number) {
  const first = replayFirstAvailable();
  const pt = Math.max(first ?? -Infinity, barTime - 1);
  void startAt(pt, paneId);
}

/** A date from the Select date dialog (UTC seconds): the bar opening at it
 *  is the first hidden one. Returns false (and starts at the first available
 *  point) when the date is older than the data. */
export function selectDate(sec: number): boolean {
  const first = replayFirstAvailable();
  const early = first !== null && sec - 1 < first;
  void startAt(early ? first! : sec - 1);
  return !early;
}

export function selectFirstAvailable() {
  const first = replayFirstAvailable();
  if (first !== null) void startAt(first);
}

/** A random time between the first available point and now (up to 10 draws
 *  to land in a session: `inSession`). */
export function selectRandom(inSession: (sec: number) => boolean = () => true) {
  const first = replayFirstAvailable();
  if (first === null) return;
  const now = Date.now() / 1000;
  let t = first;
  for (let i = 0; i < 10; i++) {
    t = first + Math.round((now - first) * Math.random());
    if (inSession(t)) break;
  }
  void startAt(t);
}

// ── Toolbar / header actions ─────────────────────────────────────────────────

export function setTimingMode(m: TimingMode) {
  setTimingSignal(m);
  kv.setItem(TIMING_KEY, m);
}

/** Run the start-point action of the current timing mode. */
export function runTimingMode() {
  switch (timing()) {
    case "bar":
      toggleSelect();
      break;
    case "date":
      setSelecting(false);
      setDateDialog(true);
      break;
    case "first":
      setSelecting(false);
      selectFirstAvailable();
      break;
    case "random": {
      setSelecting(false);
      const p = activeReplayPane();
      selectRandom(p ? p.inSession : undefined);
      break;
    }
  }
}

/** "Select bar": start / cancel the bar selection (autoplay stops). */
export function toggleSelect() {
  if (selecting()) {
    setSelecting(false);
    return;
  }
  setPlay(false);
  setSelecting(true);
}

export function cancelSelect() {
  setSelecting(false);
  setHoverTime(null);
}

export function closeDateDialog() {
  setDateDialog(false);
}

/** Header button: open the toolbar and run the start mode (Bar: select a
 *  bar; Date: the dialog; First / Random wait for a click). */
export function openReplay() {
  if (enabled()) return;
  setEnabled(true);
  if (targetPanes().length === 0) return;
  if (timing() === "bar") setSelecting(true);
  else if (timing() === "date") setDateDialog(true);
}

/** Jump to real-time chart: the charts go back to live data, the toolbar
 *  stays. */
export function stopReplay() {
  setPlay(false);
  for (const id of inReplay()) panes.get(id)?.stop();
  setInReplay([]);
  setPoint(null);
  setEpoch((n) => n + 1);
}

/** Close the toolbar (Exit Bar Replay / header button). */
export function closeReplay() {
  stopReplay();
  setSelecting(false);
  setDateDialog(false);
  setHoverTime(null);
  setFixedUpdate(null);
  setEnabled(false);
}

export function setReplayMode(m: ReplayMode) {
  setModeSignal(m);
  kv.setItem(MODE_KEY, m);
}
