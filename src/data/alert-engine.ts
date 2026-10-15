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
 *  • once_per_bar(_close) buckets are the bars of the rule's interval and
 *    session (intraday: anchored at each regular or extended session
 *    interval; daily+: the trading day / week / month in the exchange zone),
 *    timed by the latest trade when the tick carries it. A tick outside the
 *    rule's session is not evaluated (its bars do not move then). Ticks wait
 *    until the symbol's session is known.
 *  • A rule on regular hours reads the regular-session last, a rule on
 *    extended hours the latest trade (pre- and post-market included).
 */
import { createRoot, createEffect, createSignal, onCleanup } from "solid-js";
import { onTradeTick, getBars, getTickerInfo, isSupportedResolution, tickerOf, type TradeTick } from "./datafeed";
import { cachedSymbolSessions, localToUtc } from "./session";
import { periodStart } from "../window/chart/chart-aggregate";
import { setSubscription } from "./subscriptions";
import { alertStore, type AlertRule, type Operand } from "./alert-store";
import { inSchedule } from "./alert-schedule";
import type { SessionId } from "./session/symbol-sessions";
import { alertSettings } from "./alert-settings";
import { playAlertSound } from "./alert-sounds";
import { evaluatedByBackend, startAlertBackend } from "./alert-backend";
import { conditionRules, defaultAlertMessage, describeCondition, drawingBand, drawingPositionLevels, positionHit, POSITION_LEVEL_NAMES, drawingTime, drawingVwapValue, isBandOperator, isMovingOperator, isPercentOperator, operandValue, ruleComparedSymbols, ruleQuoteSymbol, type EvalContext } from "./alert-condition";
import { chartBars, chartLastBarTime, chartResolution, chartSession, indicatorPlotValue, type ChartBar } from "./chart-state-registry";
import { getIndicatorEntry } from "../window/chart/indicators/registry";
import { scriptChartContext } from "../window/chart/indicators/script-chart";
import { scriptBars } from "../backtester/oakscript";
import type { Bar } from "oakscriptjs";
import type { ChartContext } from "oakscriptjs/script";
import { OtherSymbolBars } from "../window/chart/indicators/other-symbols";
import { commands } from "../bindings";
import * as kv from "./kv";
import { REPLAY_MAX_FIRES, REPLAY_MAX_SEC, replayAlertCalls, replayCondition, replayRule } from "./alert-replay";
import { alertCallsOf, conditionBars, type StudyAlertCall } from "./alert-study-conditions";
import { fillPlaceholders, needsBarData, type PlaceholderValues } from "./alert-placeholders";
import { messageOutputs, outputValue } from "./alert-outputs";
import { isStrategyOperator } from "./alert-condition";
import { newStrategyFills, strategyFillsBetween, type StrategyAlertState, type StrategyFillEvent } from "./alert-strategy";
import { isStrategyId, strategyKeyOf } from "../window/chart/indicators/strategy-entries";
import { typeIdOf } from "../window/chart/indicators/study-id";
import { strategyTester } from "./strategy-tester-store";
import type { BacktestReport } from "../backtester/types";

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
/** Time (epoch ms) of the last fire, for every_time (at most once a minute). */
const lastFiredAt = new Map<string, number>();
const EVERY_TIME_MS = 60_000;
/** once_per_bar_close: the forming bar's bucket + the last in-bar sample.
 *  When a tick lands in a NEWER bucket the stored bar has closed — the rule is
 *  then evaluated on that final sample (so crossings compare close-to-close). */
const barCloseState = new Map<string, { bucket: number; ctx: EvalContext }>();
/** alert_function: the newest bar seen (its time in the study's bars), whether a once-per-bar call fired in it, and
 *  the last study run read (each run's calls are read once). */
const callState = new Map<string, { bar: number; once: boolean; seq: number }>();

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
 *  once-per-bar throttling, in the rule's session: intraday bars anchored at
 *  the start of each interval of that session (regular hours: 09:30, 10:30,
 *  ... on a US stock at 1 hour; extended hours: 04:00, 05:00, ...); daily /
 *  weekly / monthly bars by trading day in the exchange zone. Once a session
 *  ends, the time belongs to the next session's first bar, so the last bar
 *  closes at the session end (not at the next tick of the next session). Null
 *  until the symbol's session is known. */
function barBucket(symbol: string, res: string, session: SessionId, timeMs: number): number | null {
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
  const iv = sessions.spec(session).currentOrNext(sec);
  if (!iv) return null;
  const step = resolutionMs(res) / 1000;
  const t = Math.max(sec, iv.start);
  return (iv.start + Math.floor((t - iv.start) / step) * step) * 1000;
}

/** The rule's session: the chart's when the rule was made, regular hours for
 *  older rules. */
const ruleSession = (rule: AlertRule): SessionId => rule.session ?? DEFAULT_SESSION;

/** True when a tick at `timeMs` belongs to the rule's session: within its
 *  hours and, for regular hours, not a pre / post-market trade (the regular
 *  bars do not move then). */
function inRuleSession(rule: AlertRule, timeMs: number, extendedQuote: boolean): boolean {
  const session = ruleSession(rule);
  if (session === "RTH" && extendedQuote) return false;
  return cachedSymbolSessions(ruleQuoteSymbol(rule))?.spec(session).contains(timeMs / 1000) ?? false;
}

/** True when the rule's condition is satisfied for the current sample. Updates
 *  prevDiff as a side effect (needed for crossing). */
function conditionMet(rule: AlertRule, ctx: EvalContext): boolean {
  // A script's alert() calls are read by evaluateAlertCalls.
  if (rule.op === "alert_function") return false;
  // A study's own condition, true on the current bar.
  if (rule.op === "alert_condition") {
    return rule.left.kind === "indicator" && ctx.conditionTrue?.(rule.left, rule.resolution, rule.session) === true;
  }

  // Moving / Moving % : the left operand now against its value `bars` bars
  // back (the reference poll below), as an amount or in percent of that value.
  if (isMovingOperator(rule.op)) {
    const now = operandValue(rule.symbol, rule.left, ctx, rule.resolution, rule.session);
    const ref = movingRefCache.get(rule.id);
    if (now == null || ref == null) return false;
    const amount = rule.right.kind === "value" ? rule.right.value : 0;
    const up = rule.op === "moving_up" || rule.op === "moving_up_pct";
    if (isPercentOperator(rule.op) && ref === 0) return false;
    const change = isPercentOperator(rule.op) ? ((now - ref) / Math.abs(ref)) * 100 : now - ref;
    return up ? change >= amount : change <= -amount;
  }

  // Channel / rectangle: the left operand against the two bounds of the
  // drawing, or between an upper (right) and a lower (right2) bound.
  // Entering / exiting compare with the previous sample (stored as +1
  // inside, -1 outside), like a crossing.
  if (isBandOperator(rule.op)) {
    const v = operandValue(rule.symbol, rule.left, ctx, rule.resolution, rule.session);
    if (v == null) return false;
    let band: { lower: number; upper: number } | null;
    if (rule.right.kind === "drawing") {
      band = drawingBand(rule.symbol, rule.right.drawingId, ctx.timeSec, rule.right.level, rule.right.level2);
    } else {
      const a = operandValue(rule.symbol, rule.right, ctx, rule.resolution, rule.session);
      const b = operandValue(rule.symbol, rule.right2 ?? rule.right, ctx, rule.resolution, rule.session);
      band = a == null || b == null ? null : { lower: Math.min(a, b), upper: Math.max(a, b) };
      if (!band) return false;
    }
    // A rectangle outside its time span has no band: the price is outside it.
    if (!band && (rule.right.kind !== "drawing" || rule.right.band !== "rectangle")) return false;
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
    const crossed = (p: number) => p >= lo && p <= hi && p !== prev;
    // As the trade it draws: the entry once, then the stop or profit level (which ends the alert, see deliverFire).
    if (!positionEntryHit.has(rule.id) && crossed(lv.entry)) {
      positionEntryHit.add(rule.id);
      positionFirePrice.set(rule.id, lv.entry);
      prevDiff.set(rule.id, lv.entry);
      return true;
    }
    const exit = [lv.stop, lv.target].find(crossed);
    if (exit === undefined) return false;
    positionFirePrice.set(rule.id, exit);
    return true;
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

/** True when every condition of the rule holds for the current sample (one condition: conditionMet). Each
 *  condition is read on every sample, so a crossing keeps comparing with its own previous sample. */
function conditionsMet(rule: AlertRule, ctx: EvalContext): boolean {
  if (!rule.and?.length) return conditionMet(rule, ctx);
  const met = conditionRules(rule).map((c) => conditionMet(c, ctx));
  return met.every(Boolean);
}

/** Apply the trigger-frequency gate. `barRefMs` is the firing bar's open time
 *  (from the chart when available, else wall-clock). Returns true when a fire is
 *  allowed now, and updates the per-rule throttle state. */
function frequencyAllows(rule: AlertRule, barRefMs: number): boolean {
  switch (rule.frequency) {
    case "every_time": {
      // "Once per minute while condition remains met".
      const now = Date.now();
      const last = lastFiredAt.get(rule.id);
      if (last != null && now - last < EVERY_TIME_MS) return false;
      lastFiredAt.set(rule.id, now);
      return true;
    }
    case "only_once":
      return true; // caller disables the rule after firing
    case "once_per_bar":
    // once_per_bar_close never reaches here (onTick fires it from its own
    // bar-close branch); kept so the switch stays exhaustive.
    case "once_per_bar_close": {
      const bucket = barBucket(ruleQuoteSymbol(rule), rule.resolution, ruleSession(rule), barRefMs);
      if (bucket === null || lastFiredBucket.get(rule.id) === bucket) return false;
      lastFiredBucket.set(rule.id, bucket);
      return true;
    }
  }
}

/** A position rule: its entry has fired (once); the level of its latest hit, the price its fire gives. */
const positionEntryHit = new Set<string>();
const positionFirePrice = new Map<string, number>();

function fire(rule: AlertRule, ctx: EvalContext, barRefMs: number): void {
  // A compared symbol's alert fires at that symbol's price, a position at the level it hit.
  const price = rule.op === "hits_level"
    ? (positionFirePrice.get(rule.id) ?? ctx.price)
    : rule.left.kind === "symbol" ? (ctx.symbolPrice?.(rule.left.symbol) ?? ctx.price) : ctx.price;
  deliverFire(rule, price, barBucket(ruleQuoteSymbol(rule), rule.resolution, ruleSession(rule), barRefMs) ?? barRefMs);
}

// ── Message placeholders ──
// A fired message reads the bar of the rule's interval and session the alert
// fired in, and the plots of its source study at that bar: the chart's bars
// when a chart shows them, else fetched (at most once every few seconds per
// series, so the fires of one replay share a fetch).
const MESSAGE_BARS_MS = 5000;
const messageBarsCache = new Map<string, { at: number; bars: Promise<ChartBar[] | null> }>();

function messageBars(rule: AlertRule, fresh = false): Promise<ChartBar[] | null> {
  const session = rule.session ?? DEFAULT_SESSION;
  const charted = chartBars(rule.symbol, rule.resolution, session);
  if (charted) return Promise.resolve(charted);
  if (!isSupportedResolution(rule.resolution)) return Promise.resolve(null);
  const key = `${rule.symbol}|${rule.resolution}|${session}`;
  const now = Date.now();
  const hit = messageBarsCache.get(key);
  if (hit && !fresh && now - hit.at < MESSAGE_BARS_MS) return hit.bars;
  for (const [k, v] of messageBarsCache) if (now - v.at > 60_000) messageBarsCache.delete(k);
  const bars = getBars(rule.symbol, rule.resolution, session).then(
    (r) =>
      r.bars.flatMap((b) =>
        b.time != null && b.open != null && b.high != null && b.low != null && b.close != null
          ? [{ time: b.time as number, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume ?? 0 }]
          : [],
      ),
    () => null,
  );
  messageBarsCache.set(key, { at: now, bars });
  return bars;
}

/** Index of the bar that holds `barTime` (UNIX ms; null = the newest bar), or -1 when the bars end before it. */
function fireBarIndex(bars: ChartBar[], resolution: string, barTime: number | null): number {
  if (!bars.length) return -1;
  if (barTime == null) return bars.length - 1;
  let i = bars.length - 1;
  while (i >= 0 && bars[i].time * 1000 > barTime) i--;
  if (i < 0) return -1;
  // The newest bar loaded ends before the fire: the fire's bar is not loaded yet (a month counted as 31 days).
  const span = /M$/.test(resolution) ? (Number(resolution.slice(0, -1)) || 1) * 31 * 86_400_000 : resolutionMs(resolution);
  if (i === bars.length - 1 && bars[i].time * 1000 + span <= barTime) return -1;
  return i;
}

/** Outputs of the rule's source study at bar `i` of `bars`, in message order (plots, shapes, characters, arrows in
 *  the script's order); waits (up to `waitMs`) for a study that computes asynchronously. Null when the source is not
 *  a study (a strategy has no plot placeholders) or it cannot be computed. */
async function messagePlots(rule: AlertRule, bars: ChartBar[], i: number, live: boolean, waitMs = 10_000): Promise<PlaceholderValues["plots"]> {
  const op = rule.left;
  if (op.kind !== "indicator" || isStrategyId(op.indicatorId)) return null;
  const entry = getIndicatorEntry(op.indicatorId);
  if (!entry) return null;
  const session = rule.session ?? DEFAULT_SESSION;
  const dense = bars.slice(0, i + 1).map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume ?? 0 }));
  const state = live ? liveBarState(rule.symbol, rule.resolution, session, bars.slice(0, i + 1)) : CLOSED_BARS;
  const until = Date.now() + waitMs;
  for (;;) {
    try {
      const run = runStudy(entry, dense, op.inputs ?? entry.defaultInputs, rule.symbol, rule.resolution, session, state, `message|${rule.id}`);
      const result = run.result as { plots?: unknown; pending?: boolean } | null;
      if (result?.plots && !result.pending) {
        // The bar's time as the study was given it, and as charted.
        const times = [run.bars[i]?.time as number, bars[i].time];
        return messageOutputs(entry).map((o) => ({ title: o.title, value: outputValue(result, o, times) }));
      }
    } catch (e) {
      console.warn(`[alerts] message plots failed for ${op.indicatorId}`, e);
      return null;
    }
    if (Date.now() >= until) return null;
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** The bars of a daily, weekly or monthly rule with the trading day in progress: the daily history ends with the day
 *  before, so that day's regular-session minutes are added to the bar of the fire's period (a new bar when the period
 *  starts that day), as a chart adds them to its forming bar. `i`: index of the fire's bar, -1 when it is not loaded. */
async function withTradingDay(rule: AlertRule, bars: ChartBar[], i: number, barTime: number | null, fireTime: number): Promise<{ bars: ChartBar[]; i: number }> {
  const sessions = cachedSymbolSessions(rule.symbol);
  const iv = sessions?.regular.currentOrPrevious(fireTime / 1000);
  if (!sessions || !iv || barTime == null) return { bars, i };
  const daily = rule.resolution === "1D" ? bars : await messageBars({ ...rule, resolution: "1D" });
  // A daily bar is stamped at midnight of its trading day: the day is loaded when the newest one is that late.
  if (!daily?.length || daily[daily.length - 1].time > iv.start - 86_400) return { bars, i };
  const minutes = await messageBars({ ...rule, resolution: "1", session: "RTH" });
  const day = minutes?.filter((b) => b.time >= iv.start && b.time < iv.end) ?? [];
  if (!day.length) return { bars, i };
  const part = {
    open: day[0].open,
    high: Math.max(...day.map((b) => b.high)),
    low: Math.min(...day.map((b) => b.low)),
    volume: day.reduce((v, b) => v + (b.volume ?? 0), 0),
  };
  if (i >= 0 && bars[i].time * 1000 === barTime) {
    const b = bars[i];
    const merged = { ...b, high: Math.max(b.high, part.high), low: Math.min(b.low, part.low), volume: (b.volume ?? 0) + part.volume };
    return { bars: [...bars.slice(0, i), merged, ...bars.slice(i + 1)], i };
  }
  if (i >= 0) return { bars, i };
  return { bars: [...bars, { time: barTime / 1000, ...part, close: day[day.length - 1].close }], i: bars.length };
}

/** Open time (UNIX ms) of a bar as a message gives it: a daily, weekly or monthly bar opens with the regular session
 *  of its first day (13:30Z for a US stock, 00:00Z for a 24-hour market), not at midnight. */
function barOpenTime(rule: AlertRule, ms: number | null): number | null {
  if (ms == null || !/[DWM]$/.test(rule.resolution)) return ms;
  const iv = cachedSymbolSessions(rule.symbol)?.regular.currentOrNext(ms / 1000);
  return iv && iv.start * 1000 - ms < 86_400_000 ? iv.start * 1000 : ms;
}

/** What the placeholders of a fire give besides the bar and the study: the order fill of a strategy alert, the level
 *  a position alert hit. */
type FireDetails = Pick<PlaceholderValues, "strategy" | "position">;

/** What the placeholders of `text` give for a fire of `rule` at `price`, in the bar opened at `barTime`. */
async function placeholderValues(rule: AlertRule, text: string, price: number, barTime: number | null, fireTime: number, live: boolean, details?: FireDetails): Promise<PlaceholderValues> {
  const values: PlaceholderValues = { symbol: rule.symbol, interval: rule.resolution, barTime, fireTime, bar: null, currency: null, baseCurrency: null, plots: null, ...details };
  if (/\{\{syminfo\./.test(text)) {
    try {
      const info = await getTickerInfo(rule.symbol);
      values.currency = info.currency?.toUpperCase() ?? null;
      // A security (stock, fund, receipt, warrant) has no base currency: empty, as the reference gives it.
      if (info.symbolType) values.baseCurrency = "";
    } catch {
      /* reference data unavailable: the placeholder stays as written */
    }
  }
  values.barTime = barOpenTime(rule, barTime);
  // A strategy's alert writes prices in the symbol's price format.
  const sessions = details?.strategy ? cachedSymbolSessions(rule.symbol) : null;
  if (sessions) values.priceText = (v) => sessions.formatPrice(v);
  if (!needsBarData(text)) return values;
  let bars = await messageBars(rule);
  let i = bars ? fireBarIndex(bars, rule.resolution, barTime) : -1;
  // The fire's bar is newer than the fetched bars: fetch them again once.
  if (bars && i < 0 && !chartBars(rule.symbol, rule.resolution, rule.session ?? DEFAULT_SESSION)) {
    bars = await messageBars(rule, true);
    i = bars ? fireBarIndex(bars, rule.resolution, barTime) : -1;
  }
  // A live fire on a daily, weekly or monthly interval read from fetched bars: the day in progress is not in them.
  if (bars && live && /[DWM]$/.test(rule.resolution) && !chartBars(rule.symbol, rule.resolution, rule.session ?? DEFAULT_SESSION)) {
    ({ bars, i } = await withTradingDay(rule, bars, i, barTime, fireTime));
  }
  // Still newer for a live fire: the bar time follows the clock while the data are delayed; the fire's price belongs
  // to the newest bar loaded.
  if (bars?.length && i < 0 && live && barTime != null && barTime > bars[bars.length - 1].time * 1000) i = bars.length - 1;
  if (!bars || i < 0) return values;
  // The bar as it stood at the fire: its close is the fire's price.
  const b = bars[i];
  const bar = { time: b.time, open: b.open, high: Math.max(b.high, price), low: Math.min(b.low, price), close: price, volume: b.volume ?? 0 };
  values.bar = bar;
  values.barTime = barOpenTime(rule, b.time * 1000);
  values.plots = await messagePlots(rule, [...bars.slice(0, i), bar], i, live);
  return values;
}

/** Deliver a fire of `rule` at `price`, in the bar opened at `barTime`
 *  (epoch ms). `offline`: the time it happened, for a fire found in the bars
 *  missed while the app was not running; it goes to the log and the rule's
 *  webhook only (no sound, notification or toast). The message is sent once
 *  its placeholders are filled in. `callMessage`: the message of a script's
 *  alert() call, sent as it is. `details`: the order fill of a strategy alert,
 *  the level a position alert hit, for their placeholders. */
function deliverFire(rule: AlertRule, price: number, barTime: number | null, offline?: { fireTime: number }, callMessage?: string, details?: FireDetails): void {
  if (callMessage !== undefined) {
    sendFire(rule, price, barTime, callMessage, offline);
    return;
  }
  const fireTime = offline ? offline.fireTime : Date.now();
  const text = rule.message?.trim() ? rule.message : defaultAlertMessage(rule);
  if (rule.op === "hits_level" && rule.right.kind === "drawing") {
    // A long / short position: the level it hit; its stop or profit level ends the alert (the entry does not).
    const hit = positionHit(rule.symbol, rule.right.drawingId, price);
    details = { ...details, position: hit };
    if (!offline && hit && hit.level !== POSITION_LEVEL_NAMES.entry) alertStore.setEnabled(rule.id, false, "triggered");
  } else if (rule.frequency === "only_once") {
    // "Only Once" rules disable themselves after the single fire.
    alertStore.setEnabled(rule.id, false, "triggered");
  }
  void placeholderValues(rule, text, price, barTime, fireTime, !offline, details)
    .then(
      (values) => fillPlaceholders(text, values),
      (e) => {
        console.warn("[alerts] message placeholders not filled", e);
        return text;
      },
    )
    .then((message) => sendFire(rule, price, barTime, message, offline));
}

function sendFire(rule: AlertRule, price: number, barTime: number | null, message: string, offline?: { fireTime: number }): void {
  const now = Date.now();
  const condText = describeCondition(rule);
  // An alert on a script's alert() calls is known by its condition (its fires carry the calls' messages).
  const title = rule.name?.trim() ? rule.name : rule.op === "alert_function" || rule.op === "strategy_alerts" ? condText : `Alert · ${tickerOf(rule.symbol)}`;

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

  // Outside the notification schedule the fire is logged, nothing else (reference: notifications are muted).
  if (!inSchedule(rule.schedule, offline ? offline.fireTime : now)) return;

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

  // The in-app toast ("Show toast notification", on unless switched off).
  if (rule.toast === false) return;
  for (const fn of fireListeners) {
    try {
      fn({ alertId: rule.id, symbol: rule.symbol, title, message, time: now, sound: rule.sound });
    } catch {
      /* a bad listener must not break firing */
    }
  }
}

/** The latest tick of each symbol (a rule on a compared symbol reads both symbols). */
const lastTicks = new Map<string, TradeTick>();

/** A tick's price on a session: regular hours read the regular-session last, extended hours the latest trade. */
function tickPrice(t: TradeTick, session: string | undefined): number {
  return (session ?? DEFAULT_SESSION) === "ETH" && t.tradePrice != null ? t.tradePrice : t.price;
}

/** Evaluation contexts of `symbol` from its quote `t` (regular and extended hours). */
function tickContexts(symbol: string, t: TradeTick, now: number): { regular: EvalContext; extended: EvalContext } {
  const regular: EvalContext = {
    price: t.price,
    changePercent: t.changePercent ?? null,
    timeSec: Math.floor(now / 1000),
    indicatorValue: (op, resolution, session) => indicatorOperandValue(symbol, op, resolution, session ?? DEFAULT_SESSION, tickPrice(t, session)),
    conditionTrue: (op, resolution, session) => studyConditionNow(symbol, op, resolution, session ?? DEFAULT_SESSION, tickPrice(t, session)),
    barsFallback: (resolution, session) => drawingBarsCache.get(`${symbol}|${resolution}|${session ?? DEFAULT_SESSION}`) ?? null,
  };
  return { regular, extended: { ...regular, price: tickPrice(t, "ETH") } };
}

/** Evaluate every enabled rule for the symbol that just ticked. */
function onTick(t: TradeTick): void {
  const symbol = t.symbol.toUpperCase();
  lastTicks.set(symbol, t);
  // The backend evaluates the other rules of the symbol. A rule on a compared
  // symbol is read on the quotes of both symbols (it may compare the compared
  // symbol's price with the chart symbol's price or studies).
  const rules = alertStore.enabledRules().filter((r) => (r.symbol === symbol || ruleComparedSymbols(r).includes(symbol)) && !evaluatedByBackend(r));
  if (rules.length === 0) return;

  const now = Date.now();
  // The time of the data: the latest trade's minute when the tick carries it
  // (the quotes are delayed), else the charted bar's open time when the
  // chart's bars are no longer than the rule's (a daily chart's bar does not
  // tell which hour a 60-minute rule is in) and of the rule's session, else
  // the wall clock.
  const tradeMs = t.tradeTime != null ? Math.min(t.tradeTime * 1000, now) : null;
  const chartRef = chartLastBarTime(symbol);
  const chartRes = chartResolution(symbol);
  const chartSes = chartSession(symbol);
  const barRefFor = (rule: AlertRule) =>
    tradeMs ??
    (chartRef != null && chartRes != null && resolutionMs(chartRes) <= resolutionMs(rule.resolution) && (chartSes == null || chartSes === ruleSession(rule))
      ? chartRef
      : now);
  // The latest trade is a pre / post-market one.
  const sessions = cachedSymbolSessions(symbol);
  const extendedQuote = t.tradeTime != null && sessions != null && !sessions.regular.contains(t.tradeTime);
  // Regular hours read the regular-session last, extended hours the latest trade.
  const priceIn = (session: string | undefined) => tickPrice(t, session);
  /** The contexts of a rule's own symbol (its quote: this tick's, else the latest one); null before any. */
  const ctxCache = new Map<string, { regular: EvalContext; extended: EvalContext } | null>();
  const contextsOf = (own: string) => {
    if (ctxCache.has(own)) return ctxCache.get(own)!;
    const q = own === symbol ? t : lastTicks.get(own);
    const out = q ? tickContexts(own, q, now) : null;
    ctxCache.set(own, out);
    return out;
  };

  for (const rule of rules) {
    // Auto-expire.
    if (rule.expiresAt != null && now >= rule.expiresAt) {
      alertStore.setEnabled(rule.id, false, "expired");
      continue;
    }

    // A script's alert() calls: fired as each call allows.
    if (rule.op === "alert_function") {
      evaluateAlertCalls(rule, priceIn(rule.session));
      continue;
    }
    // A strategy: its order fills and / or its alert() calls.
    if (isStrategyOperator(rule.op)) {
      evaluateStrategy(rule, priceIn(rule.session));
      continue;
    }
    const own = contextsOf(rule.symbol);
    if (!own) continue; // the chart symbol's quote is not known yet
    const base = ruleSession(rule) === "ETH" ? own.extended : own.regular;
    // A compared symbol's price: this tick's, else its latest quote.
    const ctx: EvalContext = ruleComparedSymbols(rule).length ? { ...base, symbolPrice: (s) => { const q = s.toUpperCase() === symbol ? t : lastTicks.get(s.toUpperCase()); return q ? tickPrice(q, rule.session) : null; } } : base;

    // Real bar-close semantics: buffer the latest in-bar sample; when a tick
    // lands past the bar's end the buffered bar has closed — evaluate on ITS
    // final values (close-to-close crossings) and fire at most once per bar.
    if (rule.frequency === "once_per_bar_close") {
      const timeMs = tradeMs ?? now;
      const bucket = barBucket(ruleQuoteSymbol(rule), rule.resolution, ruleSession(rule), timeMs);
      if (bucket === null) continue; // session not known yet
      const st = barCloseState.get(rule.id);
      if (inRuleSession(rule, timeMs, extendedQuote)) {
        // A study's condition is read now, on the bar this sample belongs to (at the close the study has moved on
        // to the next bar).
        let sample = ctx;
        const own = conditionRules(rule).filter((c) => c.op === "alert_condition" && c.left.kind === "indicator");
        if (own.length) {
          // Each study condition as it is now, keyed by the study, its condition and its interval.
          const key = (o: Operand, res: string) => (o.kind === "indicator" ? `${o.indicatorId}|${o.condition?.id ?? ""}|${res}` : "");
          const now = new Map(own.map((c) => [key(c.left, c.resolution), ctx.conditionTrue?.(c.left as Extract<Operand, { kind: "indicator" }>, c.resolution, c.session) ?? null]));
          sample = { ...ctx, conditionTrue: (o, res) => now.get(key(o, res)) ?? null };
        }
        barCloseState.set(rule.id, { bucket, ctx: sample });
      } else {
        // Out of the session: no sample, but the session's last bar has closed.
        barCloseState.delete(rule.id);
      }
      if (!st || st.bucket === bucket) continue; // still forming — wait for the close
      if (!conditionsMet(rule, st.ctx)) continue;
      if (lastFiredBucket.get(rule.id) === st.bucket) continue;
      lastFiredBucket.set(rule.id, st.bucket);
      fire(rule, st.ctx, st.bucket);
      continue;
    }

    const barRefMs = barRefFor(rule);
    if (!inRuleSession(rule, barRefMs, extendedQuote)) continue;
    if (!conditionsMet(rule, ctx)) continue;
    // A position fires on every level it hits (its stop or profit level ends it, see deliverFire).
    if (rule.op !== "hits_level" && !frequencyAllows(rule, barRefMs)) continue;
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

/** Bars of other symbols for the studies of the alerts. */
const alertSymbols = new OtherSymbolBars(() => {}, "alerts");

/** State of the newest bar a study sees (`barstate.*`): closed bars by default. */
type BarState = { realtime: boolean; lastBarConfirmed: boolean; lastBarNew: boolean };
const CLOSED_BARS: BarState = { realtime: false, lastBarConfirmed: true, lastBarNew: true };

/** Newest bar of each alert series as first seen: until it moves, a calculation is its first update. */
const firstSeenBar = new Map<string, { time: number; sig: string }>();

/** State of the newest bar of live bars, as the chart gives it to its studies: forming while the clock is inside it
 *  (before its interval ends and before its session closes; a daily or longer bar while its trading day runs). */
function liveBarState(symbol: string, resolution: string, session: string, bars: ChartBar[]): BarState {
  const last = bars[bars.length - 1];
  const sessions = cachedSymbolSessions(symbol);
  if (!last || !sessions) return CLOSED_BARS;
  const now = Date.now();
  let forming: boolean;
  if (/[DWM]$/i.test(resolution)) {
    forming = barBucket(symbol, resolution, session as SessionId, now) === last.time * 1000;
  } else {
    const iv = sessions.spec(session as SessionId).currentOrNext(last.time);
    const end = Math.min(last.time + resolutionMs(resolution) / 1000, iv && iv.start <= last.time ? iv.end : Infinity);
    forming = now / 1000 >= last.time && now / 1000 < end;
  }
  if (!forming) return CLOSED_BARS;
  const key = `${symbol}|${resolution}|${session}`;
  const sig = `${last.open}:${last.high}:${last.low}:${last.close}:${last.volume}`;
  let seen = firstSeenBar.get(key);
  if (seen?.time !== last.time) firstSeenBar.set(key, (seen = { time: last.time, sig }));
  return { realtime: true, lastBarConfirmed: false, lastBarNew: seen.sig === sig };
}

/** A study computed off the chart, with the chart context of its symbol, interval and session and the state of the
 *  newest bar. */
function calculateStudy(
  entry: NonNullable<ReturnType<typeof getIndicatorEntry>>,
  bars: unknown[],
  inputs: unknown,
  symbol: string,
  resolution: string,
  session: string,
  state: BarState = CLOSED_BARS,
): unknown {
  return runStudy(entry, bars, inputs, symbol, resolution, session, state).result;
}

/** calculateStudy, with the bars the study was given. `slot`: who asks (a script keeps one run per slot). */
function runStudy(
  entry: NonNullable<ReturnType<typeof getIndicatorEntry>>,
  bars: unknown[],
  inputs: unknown,
  symbol: string,
  resolution: string,
  session: string,
  state: BarState = CLOSED_BARS,
  slot = "",
): { result: unknown; bars: Bar[] } {
  const calculate = entry.calculate as (bars: unknown[], inputs: unknown, chart: unknown) => unknown;
  const chart: ChartContext & Record<string, unknown> = {
    ...scriptChartContext(symbol, resolution, session),
    ...state,
    // Bars of other symbols (request.security of another ticker): loaded on the first request, read by the next poll.
    bars: (s, tf) => alertSymbols.bars(s, tf, resolution),
    symbolInfo: (s) => alertSymbols.symbolInfo(s),
    // Lower-timeframe bars of the symbol (profile studies), loaded on the first request.
    lowerBars: (res: string, from: number) => alertSymbols.lowerBars(symbol, res, session as SessionId, from),
    // A user script keeps one worker run per chart + study: one per alert series here.
    chartId: ALERTS_CHART,
    studyId: slot,
  };
  // Daily and longer bars at the session open, as on the chart (the values are read by bar index).
  const given = scriptBars(bars as Bar[], chart);
  // The inputs of a rule are a store proxy: a plain copy, which a user script's worker can receive.
  const plain = inputs && typeof inputs === "object" ? JSON.parse(JSON.stringify(inputs)) : inputs;
  return { result: calculate(given, plain, chart), bars: given };
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
    value = lastPlotValue(calculateStudy(entry, dense, inputs, symbol, resolution, session, liveBarState(symbol, resolution, session, bars)), plotId);
  } catch (e) {
    console.warn(`[alerts] indicator compute failed for ${op.indicatorId}`, e);
  }
  // Not computed yet (a script's worker run): ask again at the next tick.
  indicatorValueCache.set(key, { sig: value === null ? "" : sig, at: now, value });
  return value;
}

// ── Study conditions ──
// An alert on a study's condition (alert_condition) reads the study as an
// indicator operand does: on the alert's symbol, interval and session, with
// the inputs saved on the alert, computed again when the bars change (at most
// once a second). The condition is read on the newest bar.
const conditionCache = new Map<string, { sig: string; at: number; value: boolean | null }>();

function studyConditionNow(symbol: string, op: Extract<Operand, { kind: "indicator" }>, resolution: string, session: string, price: number): boolean | null {
  const entry = getIndicatorEntry(op.indicatorId);
  const id = op.condition?.id;
  if (!entry || !id) return null;
  const charted = chartBars(symbol, resolution, session);
  let bars = charted ?? drawingBarsCache.get(`${symbol}|${resolution}|${session}`) ?? null;
  if (!bars || bars.length === 0) {
    void pollDrawingBars(true);
    return null;
  }
  if (!charted) {
    const last = bars[bars.length - 1];
    bars = [...bars.slice(0, -1), { ...last, close: price, high: Math.max(last.high, price), low: Math.min(last.low, price) }];
  }
  const last = bars[bars.length - 1];
  const inputs = op.inputs ?? entry.defaultInputs;
  const series = `${symbol}|${resolution}|${session}|${op.indicatorId}|${JSON.stringify(inputs)}`;
  const key = `${series}|${id}`;
  const sig = `${bars.length}|${last.time}|${last.close}`;
  const now = Date.now();
  const hit = conditionCache.get(key);
  if (hit && (hit.sig === sig || now - hit.at < INDICATOR_COMPUTE_MS)) return hit.value;
  let value: boolean | null = null;
  try {
    const dense = bars.map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume ?? 0 }));
    const run = runStudy(entry, dense, inputs, symbol, resolution, session, liveBarState(symbol, resolution, session, bars), series);
    const flags = conditionBars(entry, run.result, id, run.bars);
    value = flags ? (flags[flags.length - 1] ?? false) : null;
  } catch (e) {
    console.warn(`[alerts] study condition failed for ${op.indicatorId}`, e);
  }
  // Not computed yet (worker run, lower-timeframe bars loading): ask again at the next tick.
  conditionCache.set(key, { sig: value === null ? "" : sig, at: now, value });
  return value;
}

// ── Script alert() calls ──
// An alert on "Any alert() function call" reads the script as a study
// condition does (the alert's symbol, interval, session and inputs, computed
// again when the bars change, at most once a second) and fires on the calls
// of the newest bar, as each call's frequency allows:
//  • alert.freq_all: every call of every run (a run = a new tick);
//  • alert.freq_once_per_bar: the first such call in the bar;
//  • alert.freq_once_per_bar_close: the calls of the bar's last run, read
//    when the next bar starts (the run that has it gives the closed bar's
//    final calls), like a once-per-bar call that only came at the close.
// A call's message is sent as it is (no placeholders).
let callsRunSeq = 0;
type AlertCallsRun = { seq: number; calls: StudyAlertCall[]; bars: Bar[]; given: ChartBar[]; result: unknown; newest: number };

/** Newest bar of the bars a result was computed on (its time in the study's bars): the last point of its plots or its
 *  last call, else the newest of `bars` (a user script can give the result of its previous run, on fewer bars). */
function resultNewestBar(result: unknown, calls: StudyAlertCall[], bars: Bar[]): number {
  let t = -Infinity;
  const plots = (result as { plots?: Record<string, Array<{ time: number }>> } | null)?.plots;
  for (const series of Object.values(plots ?? {})) {
    const last = series?.[series.length - 1];
    if (last && typeof last.time === "number") t = Math.max(t, last.time);
  }
  for (const c of calls) t = Math.max(t, c.time);
  return Number.isFinite(t) ? t : (bars[bars.length - 1]?.time as number);
}
const callsCache = new Map<string, { sig: string; at: number; value: AlertCallsRun | null }>();

function studyAlertCallsNow(symbol: string, op: Extract<Operand, { kind: "indicator" }>, resolution: string, session: string, price: number): AlertCallsRun | null {
  const entry = getIndicatorEntry(op.indicatorId);
  if (!entry) return null;
  const charted = chartBars(symbol, resolution, session);
  let bars = charted ?? drawingBarsCache.get(`${symbol}|${resolution}|${session}`) ?? null;
  if (!bars || bars.length === 0) {
    void pollDrawingBars(true);
    return null;
  }
  if (!charted) {
    const last = bars[bars.length - 1];
    bars = [...bars.slice(0, -1), { ...last, close: price, high: Math.max(last.high, price), low: Math.min(last.low, price) }];
  }
  const last = bars[bars.length - 1];
  const inputs = op.inputs ?? entry.defaultInputs;
  const key = `${symbol}|${resolution}|${session}|${op.indicatorId}|${JSON.stringify(inputs)}`;
  const sig = `${bars.length}|${last.time}|${last.close}`;
  const now = Date.now();
  const hit = callsCache.get(key);
  if (hit && (hit.sig === sig || now - hit.at < INDICATOR_COMPUTE_MS)) return hit.value;
  let value: AlertCallsRun | null = null;
  try {
    const dense = bars.map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume ?? 0 }));
    const run = runStudy(entry, dense, inputs, symbol, resolution, session, liveBarState(symbol, resolution, session, bars), key);
    const calls = alertCallsOf(run.result);
    // A user script gives its previous run's result while the next one runs in its worker: the same run, read once.
    if (calls && hit?.value && hit.value.result === run.result) value = hit.value;
    else if (calls) value = { seq: ++callsRunSeq, calls, bars: run.bars, given: bars, result: run.result, newest: resultNewestBar(run.result, calls, run.bars) };
  } catch (e) {
    console.warn(`[alerts] alert() calls failed for ${op.indicatorId}`, e);
  }
  // Not computed yet (worker run): ask again at the next tick.
  callsCache.set(key, { sig: value === null ? "" : sig, at: now, value });
  return value;
}

/** Fire the alert() calls of `rule` that the newest run allows. */
function evaluateAlertCalls(rule: AlertRule, price: number): void {
  const left = rule.left;
  if (left.kind !== "indicator") return;
  const run = studyAlertCallsNow(rule.symbol, left, rule.resolution, rule.session ?? DEFAULT_SESSION, price);
  if (run) fireAlertCalls(rule, run, price);
}

/** Fire the alert() calls of `run` (a run of the rule's script) that their frequencies allow. */
function fireAlertCalls(rule: AlertRule, run: AlertCallsRun, price: number): void {
  if (run.bars.length === 0) return;
  const newest = run.newest;
  // The bar (as given to the study, its open time in seconds) a call was made on.
  const barOf = (time: number) => {
    const i = run.bars.findIndex((b) => b.time === time);
    return i < 0 ? null : run.given[i];
  };
  const send = (c: StudyAlertCall, at: number) => {
    const b = barOf(c.time);
    deliverFire(rule, at, b ? b.time * 1000 : null, undefined, c.message);
  };
  let st = callState.get(rule.id);
  if (!st) callState.set(rule.id, (st = { bar: newest, once: false, seq: -1 }));
  if (newest < st.bar) return; // older bars than the ones read already
  if (newest > st.bar) {
    // The bar read so far has closed: this run gives its final calls.
    const closed = barOf(st.bar);
    let once = st.once;
    for (const c of run.calls) {
      if (c.time !== st.bar) continue;
      if (c.freq === "once_per_bar_close") send(c, closed?.close ?? price);
      else if (c.freq === "once_per_bar" && !once) {
        once = true;
        send(c, closed?.close ?? price);
      }
    }
    st.bar = newest;
    st.once = false;
  }
  if (run.seq === st.seq) return; // this run was read already
  st.seq = run.seq;
  for (const c of run.calls) {
    if (c.time !== newest) continue;
    if (c.freq === "all") send(c, price);
    else if (c.freq === "once_per_bar" && !st.once) {
      st.once = true;
      send(c, price);
    }
  }
}

// ── Strategies ──
// An alert on a strategy reads it as a study condition reads a study (the
// alert's symbol, interval, session and inputs, run again when the bars
// change, at most once a second): the backtest a chart runs, on the same
// bars, in the same worker, one per alert. Each order fill the report did not
// have before fires the alert once, with the fill in its message; the fills
// of the bars before the alert was first read are history. The script's
// alert() calls fire as a study's do ("Order fills and alert() function
// calls", "alert() function calls only").
type StrategyAlertRun = { report: BacktestReport | null; calls: AlertCallsRun | null; bars: Bar[]; given: ChartBar[] };
const strategyCache = new Map<string, { sig: string; at: number; value: StrategyAlertRun | null }>();
const strategyStates = new Map<string, StrategyAlertState>();
/** Chart id the strategy runs of the alerts report under (the Strategy Tester shows charts' runs only). */
const ALERTS_CHART = "alerts";

/** Study id of the strategy runs of `rule` (`purpose`: live, replay): a backtest of its own. */
function strategySlot(rule: AlertRule, op: Extract<Operand, { kind: "indicator" }>, purpose: string): string {
  return `${typeIdOf(op.indicatorId)}@${purpose}|${rule.id}`;
}

/** The report of the newest finished run of a strategy slot (a run in progress keeps the previous one). */
function slotReport(slot: string): BacktestReport | null {
  return strategyTester.run(ALERTS_CHART, strategyKeyOf(slot))?.report ?? null;
}

function strategyRunNow(rule: AlertRule, op: Extract<Operand, { kind: "indicator" }>, price: number): StrategyAlertRun | null {
  const entry = getIndicatorEntry(op.indicatorId);
  if (!entry) return null;
  const { symbol, resolution } = rule;
  const session = rule.session ?? DEFAULT_SESSION;
  const charted = chartBars(symbol, resolution, session);
  let bars = charted ?? drawingBarsCache.get(`${symbol}|${resolution}|${session}`) ?? null;
  if (!bars || bars.length === 0) {
    void pollDrawingBars(true);
    return null;
  }
  if (!charted) {
    const last = bars[bars.length - 1];
    bars = [...bars.slice(0, -1), { ...last, close: price, high: Math.max(last.high, price), low: Math.min(last.low, price) }];
  }
  const last = bars[bars.length - 1];
  const slot = strategySlot(rule, op, "live");
  const sig = `${bars.length}|${last.time}|${last.close}|${last.high}|${last.low}`;
  const now = Date.now();
  const hit = strategyCache.get(rule.id);
  // The report of a run started before arrives later: read it again while the bars stay.
  if (hit?.value && (hit.sig === sig || now - hit.at < INDICATOR_COMPUTE_MS)) return { ...hit.value, report: slotReport(slot) };
  let value: StrategyAlertRun | null = null;
  try {
    const dense = bars.map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume ?? 0 }));
    const run = runStudy(entry, dense, op.inputs ?? entry.defaultInputs, symbol, resolution, session, liveBarState(symbol, resolution, session, bars), slot);
    const calls = alertCallsOf(run.result);
    let callsRun: AlertCallsRun | null = null;
    // The visuals of the previous run while the next one runs: the same run, read once.
    if (calls && hit?.value?.calls && hit.value.calls.result === run.result) callsRun = hit.value.calls;
    else if (calls) callsRun = { seq: ++callsRunSeq, calls, bars: run.bars, given: bars, result: run.result, newest: resultNewestBar(run.result, calls, run.bars) };
    value = { report: slotReport(slot), calls: callsRun, bars: run.bars, given: bars };
  } catch (e) {
    console.warn(`[alerts] strategy run failed for ${op.indicatorId}`, e);
  }
  strategyCache.set(rule.id, { sig: value === null ? "" : sig, at: now, value });
  return value;
}

/** The bar (chart time, UNIX ms) a strategy fill happened in: the bar of the strategy's bars at the fill's time. */
function fillBarTime(fillTimeMs: number, bars: Bar[], given: ChartBar[]): number {
  const i = bars.findIndex((b) => (b.time as number) * 1000 === fillTimeMs);
  return i >= 0 && given[i] ? given[i].time * 1000 : fillTimeMs;
}

/** Fire the new order fills and the alert() calls of the strategy of `rule` (as its condition asks). */
function evaluateStrategy(rule: AlertRule, price: number): void {
  const left = rule.left;
  if (left.kind !== "indicator") return;
  const run = strategyRunNow(rule, left, price);
  if (!run) return;
  if (rule.op !== "strategy_alerts" && run.report) {
    const newest = run.given[run.given.length - 1];
    const prev = strategyStates.get(rule.id) ?? null;
    const { fire, state } = newStrategyFills(prev, run.report, newest ? newest.time * 1000 : Date.now());
    strategyStates.set(rule.id, state);
    for (const e of fire) deliverStrategyFill(rule, e, price, fillBarTime(e.fill.time, run.bars, run.given));
  }
  if (rule.op !== "strategy_orders" && run.calls) fireAlertCalls(rule, run.calls, price);
}

/** Per strategy rule, the fills delivered (bar, order, side): the replay of the missed bars and the live reading run
 *  on different bars (other sizes) and may both find a fill of the bars just loaded; it is delivered once. */
const strategyDelivered = new Map<string, Set<string>>();

/** Deliver an order fill of a strategy alert: its message filled with the fill. */
function deliverStrategyFill(rule: AlertRule, e: StrategyFillEvent, price: number, barTime: number, offline?: { fireTime: number }): void {
  let done = strategyDelivered.get(rule.id);
  if (!done) strategyDelivered.set(rule.id, (done = new Set()));
  const key = `${barTime}|${e.fill.id}|${e.values.action}`;
  if (done.has(key)) return;
  done.add(key);
  if (done.size > 500) done.delete(done.values().next().value as string);
  deliverFire(rule, price, barTime, offline, undefined, { strategy: e.values });
}

/** The report of a strategy run on closed bars (the replay); waits (up to `waitMs`) for the worker's run. */
async function strategyReplayReport(op: Extract<Operand, { kind: "indicator" }>, bars: ChartBar[], rule: AlertRule, session: string, waitMs = 60_000): Promise<{ report: BacktestReport; bars: Bar[]; calls: StudyAlertCall[] | null } | null> {
  const entry = getIndicatorEntry(op.indicatorId);
  if (!entry) return null;
  const dense = bars.map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume ?? 0 }));
  const slot = strategySlot(rule, op, "replay");
  const until = Date.now() + waitMs;
  for (;;) {
    try {
      const run = runStudy(entry, dense, op.inputs ?? entry.defaultInputs, rule.symbol, rule.resolution, session, CLOSED_BARS, slot);
      const state = strategyTester.run(ALERTS_CHART, strategyKeyOf(slot));
      if (state?.status === "error") return null;
      if (state?.status === "done" && state.report && state.bars === dense.length) {
        const calls = alertCallsOf(run.result);
        const at = new Map(run.bars.map((b, i) => [b.time as number, bars[i].time]));
        return { report: state.report, bars: run.bars, calls: calls && calls.flatMap((c) => (at.has(c.time) ? [{ ...c, time: at.get(c.time)! }] : [])) };
      }
    } catch (e) {
      console.warn(`[alerts] strategy run failed for ${op.indicatorId}`, e);
      return null;
    }
    if (Date.now() >= until) return null;
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** The alert() calls of a run on closed bars, with the times of `bars`; waits (up to `waitMs`) for a script run in
 *  its worker. */
async function alertCallSeries(op: Extract<Operand, { kind: "indicator" }>, bars: ChartBar[], rule: AlertRule, session: string, waitMs = 30_000): Promise<StudyAlertCall[] | null> {
  const entry = getIndicatorEntry(op.indicatorId);
  if (!entry) return null;
  const dense = bars.map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume ?? 0 }));
  const inputs = op.inputs ?? entry.defaultInputs;
  const slot = `replay|${rule.id}`;
  const until = Date.now() + waitMs;
  for (;;) {
    try {
      const run = runStudy(entry, dense, inputs, rule.symbol, rule.resolution, session, CLOSED_BARS, slot);
      const calls = alertCallsOf(run.result);
      if (calls) {
        const at = new Map(run.bars.map((b, i) => [b.time as number, bars[i].time]));
        return calls.flatMap((c) => (at.has(c.time) ? [{ ...c, time: at.get(c.time)! }] : []));
      }
    } catch (e) {
      console.warn(`[alerts] alert() calls failed for ${op.indicatorId}`, e);
      return null;
    }
    if (Date.now() >= until) return null;
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** Per bar, whether the study's condition is true, computed on closed bars; waits (up to `waitMs`) for a study that
 *  computes asynchronously (a user script's worker run, the lower-timeframe bars of a profile). */
async function conditionSeries(op: Extract<Operand, { kind: "indicator" }>, bars: ChartBar[], rule: AlertRule, session: string, waitMs = 30_000): Promise<boolean[] | null> {
  const entry = getIndicatorEntry(op.indicatorId);
  const id = op.condition?.id;
  if (!entry || !id) return null;
  const dense = bars.map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume ?? 0 }));
  const inputs = op.inputs ?? entry.defaultInputs;
  const slot = `replay|${rule.id}`;
  const until = Date.now() + waitMs;
  for (;;) {
    try {
      const run = runStudy(entry, dense, inputs, rule.symbol, rule.resolution, session, CLOSED_BARS, slot);
      const flags = conditionBars(entry, run.result, id, run.bars);
      if (flags) return flags;
    } catch (e) {
      console.warn(`[alerts] study condition failed for ${op.indicatorId}`, e);
      return null;
    }
    if (Date.now() >= until) return null;
    await new Promise((r) => setTimeout(r, 500));
  }
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
  for (const rule of alertStore.enabledRules().flatMap(conditionRules)) {
    const fromBars = (rule.right.kind === "drawing" && rule.right.plot != null) || rule.left.kind === "indicator" || rule.right.kind === "indicator" || rule.right2?.kind === "indicator";
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

// ── Moving reference poll ──
// "Moving Up / Down (%) … in N bars" compares the left operand now with its
// value N bars back on the rule's interval and session. The bars come from
// the datafeed (one getBars per symbol + interval + session per poll); a price operand uses the
// closes, an indicator operand its plot computed with the inputs saved on
// the alert. The value N bars before the last bar is cached per rule.
const movingRefCache = new Map<string, number | null>();
let movingPollBusy = false;

async function pollMovingRefs(): Promise<void> {
  if (movingPollBusy) return;
  const rules = alertStore.enabledRules().flatMap(conditionRules).filter((r) => isMovingOperator(r.op) && isSupportedResolution(r.resolution));
  if (rules.length === 0) return;
  movingPollBusy = true;
  try {
    const barsBy = new Map<string, { time: number; open: number; high: number; low: number; close: number; volume: number }[]>();
    for (const rule of rules) {
      const session = rule.session ?? DEFAULT_SESSION;
      // A compared symbol's price: its own bars.
      const sym = ruleQuoteSymbol(rule);
      const key = `${sym}|${rule.resolution}|${session}`;
      let bars = barsBy.get(key);
      if (!bars) {
        try {
          const res = await getBars(sym, rule.resolution, session);
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
          const result = calculateStudy(entry, bars, rule.left.inputs ?? entry.defaultInputs, rule.symbol, rule.resolution, session, liveBarState(rule.symbol, rule.resolution, session, bars)) as { plots?: Record<string, Array<{ value: number | null }>> };
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
function plotSeries(op: Extract<Operand, { kind: "indicator" }>, bars: ChartBar[], rule: AlertRule, session: string): (number | null)[] | null {
  const entry = getIndicatorEntry(op.indicatorId);
  const plotId = entry?.plotConfig[op.plot ?? 0]?.id;
  if (!entry || !plotId) return null;
  try {
    const dense = bars.map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume ?? 0 }));
    const result = calculateStudy(entry, dense, op.inputs ?? entry.defaultInputs, rule.symbol, rule.resolution, session) as { plots?: Record<string, Array<{ value: number | null }>> };
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

/** Bars of a symbol + interval + session for the replay, fetched once per run (null when they cannot be loaded). */
async function replayBars(cache: Map<string, ChartBar[]>, symbol: string, resolution: string, session: SessionId): Promise<ChartBar[] | null> {
  const key = `${symbol}|${resolution}|${session}`;
  const hit = cache.get(key);
  if (hit) return hit;
  try {
    const res = await getBars(symbol, resolution, session);
    const bars = res.bars.flatMap((b) =>
      b.time != null && b.open != null && b.high != null && b.low != null && b.close != null
        ? [{ time: b.time as number, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume ?? 0 }]
        : [],
    );
    cache.set(key, bars);
    return bars;
  } catch {
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
    // Several conditions read in the window: not replayed (the backend replays the ones it evaluates).
    if (rule.and?.length) continue;
    const { left, right } = rule;
    if (isStrategyOperator(rule.op)) {
      if (left.kind !== "indicator") continue;
      const since = (rule.activeSince ?? rule.createdAt) / 1000;
      const from = Math.max(previous[rule.symbol] ?? since, since, nowSec - REPLAY_MAX_SEC);
      if (nowSec - from < 60) continue;
      const session = rule.session ?? DEFAULT_SESSION;
      const bars = await replayBars(barsBy, rule.symbol, rule.resolution, session);
      if (!bars) continue;
      const run = await strategyReplayReport(left, bars, rule, session);
      if (!run) continue;
      if (rule.op !== "strategy_alerts") {
        for (const e of strategyFillsBetween(run.report, from * 1000, nowSec * 1000).slice(-REPLAY_MAX_FIRES)) {
          const barTime = fillBarTime(e.fill.time, run.bars, bars);
          deliverStrategyFill(rule, e, e.fill.price, barTime, { fireTime: barTime });
          found++;
        }
      }
      if (rule.op !== "strategy_orders" && run.calls) {
        for (const f of replayAlertCalls(rule, bars, run.calls, from, nowSec, resolutionMs(rule.resolution) / 1000)) {
          deliverFire(rule, f.price, f.barTime, { fireTime: f.fireTime }, f.message);
          found++;
        }
      }
      continue;
    }
    if (rule.op === "alert_function") {
      if (left.kind !== "indicator") continue;
      const since = (rule.activeSince ?? rule.createdAt) / 1000;
      const from = Math.max(previous[rule.symbol] ?? since, since, nowSec - REPLAY_MAX_SEC);
      if (nowSec - from < 60) continue;
      const session = rule.session ?? DEFAULT_SESSION;
      const bars = await replayBars(barsBy, rule.symbol, rule.resolution, session);
      if (!bars) continue;
      const calls = await alertCallSeries(left, bars, rule, session);
      if (!calls) continue;
      for (const f of replayAlertCalls(rule, bars, calls, from, nowSec, resolutionMs(rule.resolution) / 1000)) {
        deliverFire(rule, f.price, f.barTime, { fireTime: f.fireTime }, f.message);
        found++;
      }
      continue;
    }
    if (rule.op === "alert_condition") {
      if (left.kind !== "indicator") continue;
      const since = (rule.activeSince ?? rule.createdAt) / 1000;
      const from = Math.max(previous[rule.symbol] ?? since, since, nowSec - REPLAY_MAX_SEC);
      if (nowSec - from < 60) continue;
      const session = rule.session ?? DEFAULT_SESSION;
      const bars = await replayBars(barsBy, rule.symbol, rule.resolution, session);
      if (!bars) continue;
      const flags = await conditionSeries(left, bars, rule, session);
      if (!flags) continue;
      for (const f of replayCondition(rule, bars, flags, from, nowSec, resolutionMs(rule.resolution) / 1000)) {
        deliverFire(rule, f.price, f.barTime, { fireTime: f.fireTime });
        found++;
      }
      continue;
    }
    const vwap = right.kind === "drawing" && right.plot != null;
    const right2 = rule.right2;
    // A compared symbol against the chart symbol's price is read here too.
    const vsPrice = left.kind === "symbol" && (right.kind === "price" || right2?.kind === "price") || right.kind === "symbol" || right2?.kind === "symbol";
    if (!isMovingOperator(rule.op) && left.kind !== "indicator" && right.kind !== "indicator" && right2?.kind !== "indicator" && !vwap && !vsPrice) continue;
    const since = (rule.activeSince ?? rule.createdAt) / 1000;
    // A compared symbol's price: its own quotes and bars.
    const quoteSymbol = ruleQuoteSymbol(rule);
    const from = Math.max(previous[quoteSymbol] ?? since, since, nowSec - REPLAY_MAX_SEC);
    if (nowSec - from < 60) continue;
    const session = rule.session ?? DEFAULT_SESSION;
    const quoteBars = await replayBars(barsBy, quoteSymbol, rule.resolution, session);
    if (!quoteBars) continue; // no bars: nothing to read
    // A compared symbol against the chart symbol's price or studies: those are read on the chart symbol's bars, at
    // the bars both symbols have.
    const ownBars = quoteSymbol === rule.symbol ? quoteBars : await replayBars(barsBy, rule.symbol, rule.resolution, session);
    if (!ownBars) continue;
    const ownIndex = new Map(ownBars.map((b, i) => [b.time, i]));
    const bars = quoteSymbol === rule.symbol ? quoteBars : quoteBars.filter((b) => ownIndex.has(b.time));
    const aligned = (series: (number | null)[] | null) => (series && ownBars !== bars ? bars.map((b) => series[ownIndex.get(b.time)!] ?? null) : series);
    /** Closes of a compared symbol at the bars read (null where it has none). */
    const symbolSeries = async (sym: string) => {
      const other = await replayBars(barsBy, sym.toUpperCase(), rule.resolution, session);
      if (!other) return null;
      const at = new Map(other.map((b) => [b.time, b.close]));
      return bars.map((b) => at.get(b.time) ?? null);
    };
    const stepSec = resolutionMs(rule.resolution) / 1000;
    const leftSeries = left.kind === "indicator" ? plotSeries(left, bars, rule, session) : null;
    if (left.kind === "indicator" && !leftSeries) continue;
    let rightSeries: (number | null)[] | null;
    if (right.kind === "indicator") rightSeries = aligned(plotSeries(right, ownBars, rule, session));
    else if (right.kind === "price") rightSeries = aligned(ownBars.map((b) => b.close));
    else if (right.kind === "symbol") rightSeries = await symbolSeries(right.symbol);
    else if (right.kind === "value") rightSeries = bars.map(() => right.value);
    else if (right.kind === "drawing" && right.plot != null) {
      // The VWAP as it stood at each bar read (and the one before it).
      const all = bars;
      const plot = right.plot;
      const first = all.findIndex((b) => b.time + stepSec > from);
      rightSeries = all.map((_, i) => (first >= 0 && i >= first - 1 ? drawingVwapValue(rule.symbol, right.drawingId, plot, all.slice(0, i + 1)) : null));
    } else continue;
    if (!rightSeries) continue;
    // Channel between two bounds: the lower one.
    let lowerSeries: (number | null)[] | null = null;
    if (right2 && isBandOperator(rule.op)) {
      if (right2.kind === "indicator") lowerSeries = aligned(plotSeries(right2, ownBars, rule, session));
      else if (right2.kind === "value") lowerSeries = bars.map(() => right2.value);
      else if (right2.kind === "price") lowerSeries = aligned(ownBars.map((b) => b.close));
      else if (right2.kind === "symbol") lowerSeries = await symbolSeries(right2.symbol);
      if (!lowerSeries) continue;
    }
    for (const f of replayRule(rule, bars, leftSeries, rightSeries, from, nowSec, stepSec, lowerSeries)) {
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
      // A rule on a compared symbol needs that symbol's quotes.
      const symbols = [...new Set(alertStore.enabledRules().flatMap((r) => [r.symbol, ...ruleComparedSymbols(r)]))];
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
        if (r.expiresAt <= now) alertStore.setEnabled(r.id, false, "expired");
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
      const ids = new Set(rules.flatMap(conditionRules).map((r) => r.id));
      const enabledIds = new Set(rules.filter((r) => r.enabled).map((r) => r.id));
      for (const id of enabledIds) {
        if (!prevEnabledIds.has(id)) resetRuleEvalState(id);
      }
      prevEnabledIds = enabledIds;
      for (const m of [prevDiff, lastFiredBucket, lastFiredAt, barCloseState, callState]) {
        for (const id of m.keys()) if (!ids.has(id)) m.delete(id);
      }
      indicatorValueCache.clear();
      conditionCache.clear();
      callsCache.clear();
      // A new rule on an anchored VWAP or a study needs its bars now, not at the next poll.
      void pollDrawingBars(true);
    });
  });
}

/** Forget a rule's per-evaluation memory (crossing baseline + bar throttle).
 *  Call when a rule's condition changes (edit) so a stale baseline can't
 *  manufacture a spurious cross, and on delete to avoid leaking map entries. */
export function resetRuleEvalState(id: string): void {
  // The other conditions of a multi-condition alert keep their memory under `<id>#<i>`.
  for (const m of [prevDiff, movingRefCache]) {
    for (const k of [...m.keys()]) if (k.startsWith(`${id}#`)) m.delete(k);
  }
  prevDiff.delete(id);
  lastFiredBucket.delete(id);
  lastFiredAt.delete(id);
  barCloseState.delete(id);
  callState.delete(id);
  strategyStates.delete(id);
  strategyCache.delete(id);
  strategyDelivered.delete(id);
  positionEntryHit.delete(id);
  positionFirePrice.delete(id);
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
