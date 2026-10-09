/*
 * Alert engine — the window's side of the alerts: delivery of every fire
 * (toast + OS notification + sound + webhook + log entry) and evaluation of
 * the rules the backend cannot compute.
 *
 * The backend evaluates the rules that compare the price with a value or a
 * drawing's levels (data/alert-backend.ts hands them over and brings their
 * fires back here). The rules on an indicator, an anchored VWAP or a moving
 * percentage are evaluated in this module: it listens to the same live tick
 * stream the watchlist/chart use (data/datafeed-live.ts), evaluates each of
 * those rules whose symbol just ticked and respects its trigger frequency.
 *
 * It runs in one window (see `whenAlertLeader`).
 *
 * Limitations of the evaluation done here:
 *  • Indicator-operand conditions prefer the charted study values (they honour
 *    the chart's configured inputs); uncharted symbols fall back to a 60s
 *    getBars poll computed with the study's DEFAULT inputs.
 *  • Crossing is sampled between polls (~15s cadence), not tick-exact.
 *  • once_per_bar(_close) buckets follow the symbol's own session (intraday:
 *    anchored at each extended-session interval, as the rule stores no
 *    RTH/ETH choice; daily+: the trading day / week / month in the exchange
 *    zone). Ticks wait until the symbol's session is known.
 */
import { createRoot, createEffect, createSignal, onCleanup } from "solid-js";
import { onTradeTick, getBars, isSupportedResolution, tickerOf, type TradeTick } from "./datafeed";
import { cachedSymbolSessions, localToUtc } from "./session";
import { periodStart } from "../window/chart/chart-aggregate";
import { setSubscription } from "./subscriptions";
import { alertStore, type AlertRule, type Operand } from "./alert-store";
import type { SessionId } from "./session/symbol-sessions";
import { alertSettings } from "./alert-settings";
import { playAlertSound } from "./alert-sounds";
import { evaluatedByBackend, startAlertBackend } from "./alert-backend";
import { describeCondition, drawingBand, drawingPositionLevels, drawingTime, drawingVwapValue, isBandOperator, isPercentOperator, operandValue, type EvalContext } from "./alert-condition";
import { chartBars, chartLastBarTime, indicatorPlotValue, type ChartBar } from "./chart-state-registry";
import { getIndicatorEntry } from "../window/chart/indicators/registry";
import { commands } from "../bindings";
import * as kv from "./kv";
import { REPLAY_MAX_SEC, replayRule } from "./alert-replay";

/** True inside the Tauri shell — gates the native webhook route. */
const HAS_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Subscribers notified on every fire — App uses this to show a transient toast. */
type FireListener = (fire: { alertId: string; symbol: string; title: string; message: string; time: number; sound: string }) => void;
const fireListeners = new Set<FireListener>();
export function onAlertFire(fn: FireListener): () => void {
  fireListeners.add(fn);
  return () => fireListeners.delete(fn);
}

// ── Per-rule evaluation memory ──
/** Previous (left − right) difference, for crossing detection. */
const prevDiff = new Map<string, number>();
/** Bar bucket of the last fire, for once_per_bar(_close). */
const lastFiredBucket = new Map<string, number>();
/** once_per_bar_close: the forming bar's bucket + the last in-bar sample.
 *  When a tick lands in a NEWER bucket the stored bar has closed — the rule is
 *  then evaluated on that final sample (so crossings compare close-to-close). */
const barCloseState = new Map<string, { bucket: number; ctx: EvalContext }>();

// ── Per-alert webhook URLs ──
// Kept out of alert-store (its AlertRule shape follows the Fire/Alert record
// layout); keyed by rule id and persisted like the other kv maps. The dialog
// writes it, fire() posts to it, the delete paths remove it.
const WEBHOOKS_KEY = "ot:alert-webhooks:v1";
function loadWebhooks(): Record<string, string> {
  try {
    const raw = kv.getItem(WEBHOOKS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") return parsed as Record<string, string>;
    }
  } catch {
    /* malformed — start empty */
  }
  return {};
}
let webhooks = loadWebhooks();
kv.onExternalChange(WEBHOOKS_KEY, () => {
  webhooks = loadWebhooks();
});

/** The rule's webhook URL, or null when none is configured. */
export function alertWebhook(id: string): string | null {
  return webhooks[id] ?? null;
}

/** Set (or clear, with null/empty) a rule's webhook URL. */
export function setAlertWebhook(id: string, url: string | null): void {
  if (url?.trim()) webhooks[id] = url.trim();
  else if (id in webhooks) delete webhooks[id];
  else return; // nothing changed — skip the write
  try {
    kv.setItem(WEBHOOKS_KEY, JSON.stringify(webhooks));
  } catch {
    /* best-effort */
  }
}

/** Parse a resolution id into bar length ms. Bare numbers and "m" are
 *  minutes; "S" seconds, "H" hours, "D" days, "W" weeks, "M" months (~30d).
 *  Case-sensitive so "1M" (month) ≠ "1m" (minute). Defaults to one minute. */
function resolutionMs(res: string): number {
  const m = /^(\d+)\s*([a-zA-Z]?)$/.exec(res.trim());
  if (!m) return 60_000;
  const n = parseInt(m[1], 10) || 1;
  switch (m[2]) {
    case "S":
    case "s": return n * 1_000;
    case "H":
    case "h": return n * 3_600_000;
    case "D":
    case "d": return n * 86_400_000;
    case "W":
    case "w": return n * 604_800_000;
    case "M": return n * 2_592_000_000; // month ≈ 30 days
    case "m": // minutes (lowercase)
    case "": return n * 60_000;
    default: return n * 60_000;
  }
}

/** Which bar bucket (its open time, UNIX ms) a timestamp falls into, for
 *  once-per-bar throttling, in the symbol's own session: intraday bars
 *  anchored at the start of the extended-session interval; daily / weekly /
 *  monthly bars by trading day in the exchange zone. Once a session ends, the
 *  time belongs to the next session's first bar, so the last bar closes at the
 *  session end (not at the next tick of the next session). Null until the
 *  symbol's session is known. */
function barBucket(symbol: string, res: string, timeMs: number): number | null {
  const sessions = cachedSymbolSessions(symbol);
  if (!sessions) return null;
  const sec = timeMs / 1000;
  const m = /^(\d*)\s*([a-zA-Z]?)$/.exec(res.trim());
  const unit = m?.[2] ?? "";
  const n = Number(m?.[1] || 1);
  if (unit === "D" || unit === "d" || unit === "W" || unit === "w" || unit === "M") {
    const iv = sessions.regular.currentOrNext(sec);
    if (!iv) return null;
    const day = localToUtc(sessions.timeZone, iv.day, 0);
    const period = unit === "W" || unit === "w" ? "week" : unit === "M" ? "month" : "day";
    const key = period === "day" && n === 1 ? day : periodStart(day, { unit: period, n }, sessions.regular);
    return key * 1000;
  }
  const iv = sessions.extended.currentOrNext(sec);
  if (!iv) return null;
  const step = resolutionMs(res) / 1000;
  const t = Math.max(sec, iv.start);
  return (iv.start + Math.floor((t - iv.start) / step) * step) * 1000;
}

/** True when the rule's condition is satisfied for the current sample. Updates
 *  prevDiff as a side effect (needed for crossing). */
function conditionMet(rule: AlertRule, ctx: EvalContext): boolean {
  // Moving % : the left operand now against its value `bars` bars back (the
  // reference poll below), in percent of that value.
  if (isPercentOperator(rule.op)) {
    const now = operandValue(rule.symbol, rule.left, ctx, rule.resolution, rule.session);
    const ref = movingRefCache.get(rule.id);
    if (now == null || ref == null || ref === 0) return false;
    const change = ((now - ref) / Math.abs(ref)) * 100;
    const pct = rule.right.kind === "value" ? rule.right.value : 0;
    return rule.op === "moving_up_pct" ? change >= pct : change <= -pct;
  }

  // Channel / rectangle: the left operand against the two bounds of the
  // drawing. Entering / exiting compare with the previous sample (stored as
  // +1 inside, -1 outside), like a crossing.
  if (isBandOperator(rule.op)) {
    const v = operandValue(rule.symbol, rule.left, ctx, rule.resolution, rule.session);
    if (v == null || rule.right.kind !== "drawing") return false;
    const band = drawingBand(rule.symbol, rule.right.drawingId, ctx.timeSec, rule.right.level, rule.right.level2);
    // A rectangle outside its time span has no band: the price is outside it.
    if (!band && rule.right.band !== "rectangle") return false;
    const inside = !!band && v >= band.lower && v <= band.upper;
    if (rule.op === "inside") return inside;
    if (rule.op === "outside") return !inside;
    const prev = prevDiff.get(rule.id);
    prevDiff.set(rule.id, inside ? 1 : -1);
    if (prev == null) return false;
    return rule.op === "entering" ? prev < 0 && inside : prev > 0 && !inside;
  }

  // Vertical line: the time reaches the line (previous sample before it).
  if (rule.right.kind === "drawing" && rule.right.band === "time") {
    const t = drawingTime(rule.symbol, rule.right.drawingId);
    if (t == null) return false;
    const diff = ctx.timeSec - t;
    const prev = prevDiff.get(rule.id);
    prevDiff.set(rule.id, diff);
    return prev != null && prev < 0 && diff >= 0;
  }

  // Position: the left operand reaches the entry, stop or target level (the
  // level lies between the previous sample and this one).
  if (rule.op === "hits_level") {
    const v = operandValue(rule.symbol, rule.left, ctx, rule.resolution, rule.session);
    if (v == null || rule.right.kind !== "drawing") return false;
    const lv = drawingPositionLevels(rule.symbol, rule.right.drawingId, ctx.timeSec);
    const prev = prevDiff.get(rule.id);
    prevDiff.set(rule.id, v);
    if (!lv || prev == null || prev === v) return false;
    const lo = Math.min(prev, v);
    const hi = Math.max(prev, v);
    return [lv.entry, lv.stop, lv.target].some((p) => p >= lo && p <= hi && p !== prev);
  }

  // Rectangle, Greater / Less than: above its top, below its bottom (while
  // the time is within the rectangle).
  if (rule.right.kind === "drawing" && rule.right.band === "rectangle") {
    const v = operandValue(rule.symbol, rule.left, ctx, rule.resolution, rule.session);
    const band = drawingBand(rule.symbol, rule.right.drawingId, ctx.timeSec);
    if (v == null || !band) return false;
    return rule.op === "greater" ? v > band.upper : rule.op === "less" ? v < band.lower : false;
  }

  const left = operandValue(rule.symbol, rule.left, ctx, rule.resolution, rule.session);
  const right = operandValue(rule.symbol, rule.right, ctx, rule.resolution, rule.session);
  if (left == null || right == null) return false;

  switch (rule.op) {
    case "greater":
      return left > right;
    case "less":
      return left < right;
    case "crossing":
    case "crossing_up":
    case "crossing_down": {
      const diff = left - right;
      const prev = prevDiff.get(rule.id);
      prevDiff.set(rule.id, diff);
      if (prev == null) return false; // need a baseline sample first
      if (rule.op === "crossing_up") return prev <= 0 && diff > 0;
      if (rule.op === "crossing_down") return prev >= 0 && diff < 0;
      return (prev <= 0 && diff > 0) || (prev >= 0 && diff < 0);
    }
    default:
      return false;
  }
}

/** Apply the trigger-frequency gate. `barRefMs` is the firing bar's open time
 *  (from the chart when available, else wall-clock). Returns true when a fire is
 *  allowed now, and updates the per-rule throttle state. */
function frequencyAllows(rule: AlertRule, barRefMs: number): boolean {
  switch (rule.frequency) {
    case "every_time":
      return true;
    case "only_once":
      return true; // caller disables the rule after firing
    case "once_per_bar":
    // once_per_bar_close never reaches here (onTick fires it from its own
    // bar-close branch); kept so the switch stays exhaustive.
    case "once_per_bar_close": {
      const bucket = barBucket(rule.symbol, rule.resolution, barRefMs);
      if (bucket === null || lastFiredBucket.get(rule.id) === bucket) return false;
      lastFiredBucket.set(rule.id, bucket);
      return true;
    }
  }
}

function fire(rule: AlertRule, ctx: EvalContext, barRefMs: number): void {
  deliverFire(rule, ctx.price, barBucket(rule.symbol, rule.resolution, barRefMs) ?? barRefMs);
}

/** Deliver a fire of `rule` at `price`, in the bar opened at `barTime`
 *  (epoch ms). `offline`: the time it happened, for a fire found in the bars
 *  missed while the app was not running; it goes to the log and the rule's
 *  webhook only (no sound, notification or toast). */
function deliverFire(rule: AlertRule, price: number, barTime: number | null, offline?: { fireTime: number }): void {
  const now = Date.now();
  const condText = describeCondition(rule);
  const message = rule.message?.trim()
    ? rule.message
    : `${tickerOf(rule.symbol)} ${condText} (last ${price})`;
  const title = rule.name?.trim() ? rule.name : `Alert · ${tickerOf(rule.symbol)}`;

  alertStore.recordFire({
    alertId: rule.id,
    symbol: rule.symbol,
    resolution: rule.resolution,
    name: rule.name?.trim() ? rule.name : null,
    message,
    fireTime: offline ? offline.fireTime : now,
    barTime,
    soundFile: rule.sound,
    logoUrl: null,
    ...(offline ? { offline: true, receivedAt: now } : {}),
  });

  // "Only Once" rules disable themselves after the single fire.
  if (rule.frequency === "only_once") {
    alertStore.setEnabled(rule.id, false);
  }
  if (!offline) playAlertSound(rule.sound, { duration: rule.soundDuration ?? 0 });

  // Webhook — fire-and-forget; a failing endpoint must not affect local delivery.
  // An offline fire is posted too, with the time it happened and `offline`.
  const webhookUrl = alertWebhook(rule.id);
  if (webhookUrl) {
    const payload = JSON.stringify({
      id: rule.id,
      name: title,
      symbol: rule.symbol,
      price,
      condition: condText,
      message,
      time: new Date(offline ? offline.fireTime : now).toISOString(),
      ...(offline ? { offline: true } : {}),
    });
    // Native POST in the shell: the webview's fetch originates from
    // tauri.localhost, so most receivers reject its CORS preflight. Plain fetch
    // covers the browser / headless-verify harness (which stubs invoke).
    if (HAS_TAURI) {
      void commands.postWebhook(webhookUrl, payload).then((r) => {
        if (r.status === "error") console.warn("[alerts] webhook post failed", r.error);
      });
    } else {
      try {
        void fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: payload,
        }).catch((e) => console.warn("[alerts] webhook post failed", e));
      } catch (e) {
        console.warn("[alerts] webhook post failed", e);
      }
    }
  }
  if (offline) return;

  if (rule.popup && alertSettings.systemNotifications()) {
    try {
      if (typeof Notification !== "undefined" && Notification.permission === "granted") {
        new Notification(title, { body: message });
      }
    } catch {
      /* notifications unavailable — toast/log still cover it */
    }
  }

  for (const fn of fireListeners) {
    try {
      fn({ alertId: rule.id, symbol: rule.symbol, title, message, time: now, sound: rule.sound });
    } catch {
      /* a bad listener must not break firing */
    }
  }
}

/** Evaluate every enabled rule for the symbol that just ticked. */
function onTick(t: TradeTick): void {
  const symbol = t.symbol.toUpperCase();
  // The backend evaluates the other rules of the symbol.
  const rules = alertStore.enabledRules().filter((r) => r.symbol === symbol && !evaluatedByBackend(r));
  if (rules.length === 0) return;

  const now = Date.now();
  // Prefer the charted bar's open time for once-per-bar throttling + the fire's
  // bar_time; falls back to wall-clock for symbols that aren't charted.
  const barRefMs = chartLastBarTime(symbol) ?? now;
  const ctx: EvalContext = {
    price: t.price,
    changePercent: t.changePercent ?? null,
    timeSec: Math.floor(now / 1000),
    indicatorValue: (op, resolution, session) => indicatorOperandValue(symbol, op, resolution, session ?? DEFAULT_SESSION, t.price),
    barsFallback: (resolution, session) => drawingBarsCache.get(`${symbol}|${resolution}|${session ?? DEFAULT_SESSION}`) ?? null,
  };

  for (const rule of rules) {
    // Auto-expire.
    if (rule.expiresAt != null && now >= rule.expiresAt) {
      alertStore.setEnabled(rule.id, false);
      continue;
    }

    // Real bar-close semantics: buffer the latest in-bar sample; when a tick
    // lands past the bar's end the buffered bar has closed — evaluate on ITS
    // final values (close-to-close crossings) and fire at most once per bar.
    if (rule.frequency === "once_per_bar_close") {
      const bucket = barBucket(rule.symbol, rule.resolution, now);
      if (bucket === null) continue; // session not known yet
      const st = barCloseState.get(rule.id);
      barCloseState.set(rule.id, { bucket, ctx });
      if (!st || st.bucket === bucket) continue; // still forming — wait for the close
      if (!conditionMet(rule, st.ctx)) continue;
      if (lastFiredBucket.get(rule.id) === st.bucket) continue;
      lastFiredBucket.set(rule.id, st.bucket);
      fire(rule, st.ctx, st.bucket);
      continue;
    }

    if (!conditionMet(rule, ctx)) continue;
    if (!frequencyAllows(rule, barRefMs)) continue;
    fire(rule, ctx, barRefMs);
  }
}

// ── Indicator operands ──
// An alert on a study reads it on the alert's own symbol and interval, with
// the inputs saved when the alert was made: what the chart shows later (other
// interval, other symbol, changed or removed study) does not change it. The
// bars are those of the alert's session (regular or extended hours, the
// chart's when the alert was made): the chart's when a chart shows the symbol
// that way (live), else the fetched ones (see the bars poll below), their
// last bar brought to the current price. The study is computed again when the bars change, at
// most once a second per operand.
const INDICATOR_POLL_MS = 60_000;
const INDICATOR_COMPUTE_MS = 1000;
/** Session of an alert made before alerts kept theirs: a chart's default. */
const DEFAULT_SESSION: SessionId = "RTH";
const indicatorValueCache = new Map<string, { sig: string; at: number; value: number | null }>();
let indicatorPollTimer: ReturnType<typeof setInterval> | null = null;

/** Latest finite value of one plot series (index per the entry's plotConfig
 *  order — the same order the dialog's plot-0 convention uses). */
function lastPlotValue(result: unknown, plotId: string): number | null {
  const plots = (result as { plots?: Record<string, Array<{ value: number | null }>> } | null)?.plots;
  const series = plots?.[plotId];
  if (!series) return null;
  for (let i = series.length - 1; i >= 0; i--) {
    const v = series[i]?.value;
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

function indicatorOperandValue(symbol: string, op: Extract<Operand, { kind: "indicator" }>, resolution: string, session: string, price: number): number | null {
  const plot = op.plot ?? 0;
  const entry = getIndicatorEntry(op.indicatorId);
  const plotId = entry?.plotConfig[plot]?.id;
  if (!entry || !plotId) return null;
  const charted = chartBars(symbol, resolution, session);
  // An older alert has no inputs of its own: the charted study's value while
  // a chart shows the symbol on the alert's interval, else the factory inputs.
  if (!op.inputs && charted) {
    const live = indicatorPlotValue(symbol, op.indicatorId, plot);
    if (live != null) return live;
  }
  let bars = charted ?? drawingBarsCache.get(`${symbol}|${resolution}|${session}`) ?? null;
  if (!bars || bars.length === 0) {
    // Not fetched yet (the symbol just left the chart): fetch now.
    void pollDrawingBars(true);
    return null;
  }
  if (!charted) {
    const last = bars[bars.length - 1];
    bars = [...bars.slice(0, -1), { ...last, close: price, high: Math.max(last.high, price), low: Math.min(last.low, price) }];
  }
  const last = bars[bars.length - 1];
  const inputs = op.inputs ?? entry.defaultInputs;
  const key = `${symbol}|${resolution}|${session}|${op.indicatorId}|${plot}|${JSON.stringify(inputs)}`;
  const sig = `${bars.length}|${last.time}|${last.close}`;
  const now = Date.now();
  const hit = indicatorValueCache.get(key);
  if (hit && (hit.sig === sig || now - hit.at < INDICATOR_COMPUTE_MS)) return hit.value;
  let value: number | null = null;
  try {
    const dense = bars.map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume ?? 0 }));
    value = lastPlotValue(entry.calculate(dense, inputs), plotId);
  } catch (e) {
    console.warn(`[alerts] indicator compute failed for ${op.indicatorId}`, e);
  }
  indicatorValueCache.set(key, { sig, at: now, value });
  return value;
}

// ── Bars for the operands computed from bars ──
// An anchored VWAP has no fixed level: its value comes from the bars since
// its anchor, on the rule's interval; a study is computed from the bars of
// the rule's interval. Both on the rule's session (regular or extended
// hours). A chart showing the symbol that way serves them live
// (chart-state-registry); otherwise the bars are fetched here, once a
// minute, and kept per symbol + interval + session.
const drawingBarsCache = new Map<string, ChartBar[]>();
let drawingPollBusy = false;

/** `onlyMissing`: fetch only the series not cached yet (a rule was added). */
async function pollDrawingBars(onlyMissing = false): Promise<void> {
  if (drawingPollBusy) return;
  const jobs = new Map<string, { symbol: string; resolution: string; session: SessionId }>();
  for (const rule of alertStore.enabledRules()) {
    const fromBars = (rule.right.kind === "drawing" && rule.right.plot != null) || rule.left.kind === "indicator" || rule.right.kind === "indicator";
    if (!fromBars || !isSupportedResolution(rule.resolution)) continue;
    const session = rule.session ?? DEFAULT_SESSION;
    jobs.set(`${rule.symbol}|${rule.resolution}|${session}`, { symbol: rule.symbol, resolution: rule.resolution, session });
  }
  for (const k of drawingBarsCache.keys()) if (!jobs.has(k)) drawingBarsCache.delete(k);
  drawingPollBusy = true;
  try {
    for (const [key, job] of jobs) {
      // A chart on that interval already serves live bars: no fetch needed.
      if (chartBars(job.symbol, job.resolution, job.session) || (onlyMissing && drawingBarsCache.has(key))) continue;
      try {
        const { bars } = await getBars(job.symbol, job.resolution, job.session);
        drawingBarsCache.set(
          key,
          bars.flatMap((b) =>
            b.time != null && b.open != null && b.high != null && b.low != null && b.close != null
              ? [{ time: b.time as number, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume ?? 0 }]
              : [],
          ),
        );
      } catch {
        /* fetch failed: keep the cached bars */
      }
    }
  } finally {
    drawingPollBusy = false;
  }
}

// ── Moving % reference poll ──
// "Moving up / down % … in N bars" compares the left operand now with its
// value N bars back on the rule's interval and session. The bars come from
// the datafeed (one getBars per symbol + interval + session per poll); a price operand uses the
// closes, an indicator operand its plot computed with the inputs saved on
// the alert. The value N bars before the last bar is cached per rule.
const movingRefCache = new Map<string, number | null>();
let movingPollBusy = false;

async function pollMovingRefs(): Promise<void> {
  if (movingPollBusy) return;
  const rules = alertStore.enabledRules().filter((r) => isPercentOperator(r.op) && isSupportedResolution(r.resolution));
  if (rules.length === 0) return;
  movingPollBusy = true;
  try {
    const barsBy = new Map<string, { time: number; open: number; high: number; low: number; close: number; volume: number }[]>();
    for (const rule of rules) {
      const session = rule.session ?? DEFAULT_SESSION;
      const key = `${rule.symbol}|${rule.resolution}|${session}`;
      let bars = barsBy.get(key);
      if (!bars) {
        try {
          const res = await getBars(rule.symbol, rule.resolution, session);
          bars = res.bars.flatMap((b) =>
            b.time != null && b.open != null && b.high != null && b.low != null && b.close != null
              ? [{ time: b.time as number, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume ?? 0 }]
              : [],
          );
        } catch {
          continue; // fetch failed: keep the cached reference
        }
        barsBy.set(key, bars);
      }
      const n = Math.max(1, Math.min(300, Math.round(rule.bars ?? 1)));
      const at = bars.length - 1 - n;
      if (at < 0) {
        movingRefCache.set(rule.id, null);
        continue;
      }
      if (rule.left.kind === "indicator") {
        const entry = getIndicatorEntry(rule.left.indicatorId);
        const plotId = entry?.plotConfig[rule.left.plot ?? 0]?.id;
        if (!entry || !plotId) continue;
        try {
          const result = entry.calculate(bars, rule.left.inputs ?? entry.defaultInputs) as { plots?: Record<string, Array<{ value: number | null }>> };
          const v = result.plots?.[plotId]?.[at]?.value;
          movingRefCache.set(rule.id, typeof v === "number" && Number.isFinite(v) ? v : null);
        } catch (e) {
          console.warn(`[alerts] moving reference compute failed for ${rule.left.indicatorId}`, e);
        }
      } else {
        movingRefCache.set(rule.id, bars[at].close);
      }
    }
  } finally {
    movingPollBusy = false;
  }
}

// ── The bars missed while the app was not running ──
// The backend replays its own rules (alert-backend.ts). The rules evaluated
// here are read again at start, bar by bar on their interval and session
// (alert-replay.ts); what they find goes to the log and the rule's webhook
// only, as fires that happened while the app was closed.
const REPLAYED_KEY = "alerts.replayed-run.v1";

/** Value of a study's plot at the close of every bar. */
function plotSeries(op: Extract<Operand, { kind: "indicator" }>, bars: ChartBar[]): (number | null)[] | null {
  const entry = getIndicatorEntry(op.indicatorId);
  const plotId = entry?.plotConfig[op.plot ?? 0]?.id;
  if (!entry || !plotId) return null;
  try {
    const dense = bars.map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume ?? 0 }));
    const result = entry.calculate(dense, op.inputs ?? entry.defaultInputs) as { plots?: Record<string, Array<{ value: number | null }>> };
    const series = result.plots?.[plotId];
    if (!series) return null;
    return bars.map((_, i) => {
      const v = series[i]?.value;
      return typeof v === "number" && Number.isFinite(v) ? v : null;
    });
  } catch (e) {
    console.warn(`[alerts] study compute failed for ${op.indicatorId}`, e);
    return null;
  }
}

/** Read the rules evaluated in the window over the bars since the previous
 *  run and deliver what they find. `previous`: per symbol, the time (UNIX
 *  seconds) of its last quote in the previous run. Returns the fires found. */
export async function replayMissedFires(previous: Record<string, number | null | undefined>, nowSec = Math.floor(Date.now() / 1000)): Promise<number> {
  let found = 0;
  const barsBy = new Map<string, ChartBar[]>();
  for (const rule of alertStore.enabledRules()) {
    if (evaluatedByBackend(rule) || !isSupportedResolution(rule.resolution)) continue;
    const { left, right } = rule;
    const vwap = right.kind === "drawing" && right.plot != null;
    if (!isPercentOperator(rule.op) && left.kind !== "indicator" && right.kind !== "indicator" && !vwap) continue;
    const since = (rule.activeSince ?? rule.createdAt) / 1000;
    const from = Math.max(previous[rule.symbol] ?? since, since, nowSec - REPLAY_MAX_SEC);
    if (nowSec - from < 60) continue;
    const session = rule.session ?? DEFAULT_SESSION;
    const key = `${rule.symbol}|${rule.resolution}|${session}`;
    let bars = barsBy.get(key);
    if (!bars) {
      try {
        const res = await getBars(rule.symbol, rule.resolution, session);
        bars = res.bars.flatMap((b) =>
          b.time != null && b.open != null && b.high != null && b.low != null && b.close != null
            ? [{ time: b.time as number, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume ?? 0 }]
            : [],
        );
      } catch {
        continue; // no bars: nothing to read
      }
      barsBy.set(key, bars);
    }
    const stepSec = resolutionMs(rule.resolution) / 1000;
    const leftSeries = left.kind === "indicator" ? plotSeries(left, bars) : null;
    if (left.kind === "indicator" && !leftSeries) continue;
    let rightSeries: (number | null)[] | null;
    if (right.kind === "indicator") rightSeries = plotSeries(right, bars);
    else if (right.kind === "value") rightSeries = bars.map(() => right.value);
    else if (right.kind === "drawing" && right.plot != null) {
      // The VWAP as it stood at each bar read (and the one before it).
      const all = bars;
      const plot = right.plot;
      const first = all.findIndex((b) => b.time + stepSec > from);
      rightSeries = all.map((_, i) => (first >= 0 && i >= first - 1 ? drawingVwapValue(rule.symbol, right.drawingId, plot, all.slice(0, i + 1)) : null));
    } else continue;
    if (!rightSeries) continue;
    for (const f of replayRule(rule, bars, leftSeries, rightSeries, from, nowSec, stepSec)) {
      deliverFire(rule, f.price, f.barTime, { fireTime: f.fireTime });
      found++;
    }
  }
  return found;
}

let started = false;
let unlisten: (() => void) | null = null;
/** Bumped when the nearest alert expiry time is reached (re-runs the expiry effect). */
const [expiryTick, setExpiryTick] = createSignal(0);

/** Stop the engine's tick listener (the subscription effect lives in a root and
 *  persists). Mainly for tests / teardown; the app runs the engine for life. */
export function stopAlertEngine(): void {
  unlisten?.();
  unlisten = null;
  if (indicatorPollTimer != null) {
    clearInterval(indicatorPollTimer);
    indicatorPollTimer = null;
  }
  started = false;
}

/** Start the engine: wire the tick listener, hand the backend its rules and
 *  keep it subscribed to the union of enabled-rule symbols. Idempotent.
 *  `windowLabel`: the window it runs in (the fires addressed to it). */
export function startAlertEngine(windowLabel = "main"): void {
  if (started) return;
  started = true;

  startAlertBackend(
    (f) => deliverFire(f.rule, f.price, f.barTime, f.offline ? { fireTime: f.fireTime } : undefined),
    windowLabel,
  );

  onTradeTick(onTick).then((u) => {
    unlisten = u;
  });

  // Once per run of the app: the fires missed while it was not running.
  if (HAS_TAURI) {
    void commands
      .alertEngineInfo()
      .then((info) => {
        const run = JSON.stringify(info.previous);
        if (kv.getItem(REPLAYED_KEY) === run) return;
        kv.setItem(REPLAYED_KEY, run);
        return replayMissedFires(info.previous);
      })
      .catch((e) => console.warn("[alerts] missed bars not read", e));
  }

  // Bars of the uncharted operands: prime once, then refresh every minute.
  void pollMovingRefs();
  void pollDrawingBars();
  indicatorPollTimer = setInterval(() => {
    void pollMovingRefs();
    void pollDrawingBars();
  }, INDICATOR_POLL_MS);

  // Keep the alert symbol-subscription in sync with the enabled rules so ticks
  // arrive even for symbols that aren't charted or in any watchlist. Contributes
  // to the shared watchlist feed via the subscription coordinator.
  createRoot(() => {
    createEffect(() => {
      const symbols = [...new Set(alertStore.enabledRules().map((r) => r.symbol))];
      setSubscription("alerts", symbols);
    });

    // Expiry: stop each rule at its expiration time, whether or not its
    // symbol trades. One timer for the nearest expiry, re-armed on changes
    // (delay capped: setTimeout overflows past ~24.8 days).
    createEffect(() => {
      const now = Date.now();
      let next = Infinity;
      for (const r of alertStore.enabledRules()) {
        if (r.expiresAt == null) continue;
        if (r.expiresAt <= now) alertStore.setEnabled(r.id, false);
        else next = Math.min(next, r.expiresAt);
      }
      if (next === Infinity) return;
      const timer = setTimeout(() => setExpiryTick((n) => n + 1), Math.min(next - now, 86_400_000) + 50);
      expiryTick();
      onCleanup(() => clearTimeout(timer));
    });

    // Eval-state hygiene, tracking the rules list (which also syncs in from
    // other windows via the store's kv onExternalChange):
    //  • disabled → enabled: drop the rule's pre-disable memory — a stale
    //    once_per_bar_close buffer would otherwise fire on old data, and a
    //    stale crossing baseline can manufacture a spurious cross.
    //  • deleted (here or in another window): prune the per-rule maps so ids
    //    that no longer exist can't leak entries.
    //  • computed study values: dropped, the rules that are left compute
    //    theirs again.
    let prevEnabledIds = new Set<string>();
    createEffect(() => {
      const rules = alertStore.rules();
      const ids = new Set(rules.map((r) => r.id));
      const enabledIds = new Set(rules.filter((r) => r.enabled).map((r) => r.id));
      for (const id of enabledIds) {
        if (!prevEnabledIds.has(id)) resetRuleEvalState(id);
      }
      prevEnabledIds = enabledIds;
      for (const m of [prevDiff, lastFiredBucket, barCloseState]) {
        for (const id of m.keys()) if (!ids.has(id)) m.delete(id);
      }
      indicatorValueCache.clear();
      // A new rule on an anchored VWAP or a study needs its bars now, not at the next poll.
      void pollDrawingBars(true);
    });
  });
}

/** Forget a rule's per-evaluation memory (crossing baseline + bar throttle).
 *  Call when a rule's condition changes (edit) so a stale baseline can't
 *  manufacture a spurious cross, and on delete to avoid leaking map entries. */
export function resetRuleEvalState(id: string): void {
  prevDiff.delete(id);
  lastFiredBucket.delete(id);
  barCloseState.delete(id);
  // A changed Moving % rule needs its reference now, not at the next poll.
  movingRefCache.delete(id);
  if (started) void pollMovingRefs();
}

/** Request OS-notification permission (call from a user gesture, e.g. saving a
 *  popup alert in the dialog). */
export function ensureNotificationPermission(): void {
  try {
    if (typeof Notification !== "undefined" && Notification.permission === "default") {
      void Notification.requestPermission();
    }
  } catch {
    /* unsupported context */
  }
}
