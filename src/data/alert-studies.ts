/*
 * The studies the alerts read, computed off the chart: an indicator operand's
 * value, a study's own condition, a script's alert() calls, each on the
 * alert's symbol, interval and session with the inputs saved on the alert;
 * the bars they are computed from (the chart's when a chart shows them, else
 * fetched here once a minute); the series the replay of the missed bars reads.
 */
import { seedSymbol } from "./symbol-name";
import { getBars, isSupportedResolution } from "./datafeed";
import { cachedSymbolSessions } from "./session";
import type { SessionId } from "./session/symbol-sessions";
import { conditionRules } from "./alert-condition";
import type { AlertRule, Operand } from "./alert-store";
import { chartBars, chartLastPrice, indicatorPlotValue, type ChartBar } from "./chart-state-registry";
import { getIndicatorEntry } from "../window/chart/indicators/registry";
import { scriptChartContext } from "../window/chart/indicators/script-chart";
import { scriptBars } from "../backtester/oakscript";
import { setSourceResolver, type Bar } from "oakscriptjs";
import { alignToBars, sourceSpecsOf, SOURCES_KEY, type SourceSpec } from "../window/chart/indicators/study-sources";
import { priceOf } from "../window/chart/series-transforms";
import type { OHLC } from "../window/chart/chart-types";
import type { ChartContext } from "oakscriptjs/script";
import { OtherSymbolBars } from "../window/chart/indicators/other-symbols";
import { alertCallsOf, conditionBars, type StudyAlertCall } from "./alert-study-conditions";
import { outputByKey, outputSeries, outputValue } from "./alert-outputs";
import { barBucket, DEFAULT_SESSION, engineRules, resolutionMs } from "./alert-bars";
import { isDailyInterval } from "./interval";

/** Chart id the strategy runs of the alerts report under (the Strategy Tester shows charts' runs only). */
export const ALERTS_CHART = "alerts";

// ── Indicator operands ──
// An alert on a study reads it on the alert's own symbol and interval, with
// the inputs saved when the alert was made: what the chart shows later (other
// interval, other symbol, changed or removed study) does not change it. The
// bars are those of the alert's session (regular or extended hours, the
// chart's when the alert was made): the chart's when a chart shows the symbol
// that way (live), else the fetched ones (see the bars poll below), their
// last bar brought to the current price. The study is computed again when the bars change, at
// most once a second per operand.
export const INDICATOR_POLL_MS = 60_000;
export const INDICATOR_COMPUTE_MS = 1000;
const indicatorValueCache = new Map<string, { sig: string; at: number; value: number | null }>();

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
export type BarState = { realtime: boolean; lastBarConfirmed: boolean; lastBarNew: boolean };
export const CLOSED_BARS: BarState = { realtime: false, lastBarConfirmed: true, lastBarNew: true };

/** Newest bar of each alert series as first seen: until it moves, a calculation is its first update. */
const firstSeenBar = new Map<string, { time: number; sig: string }>();

/** State of the newest bar of live bars, as the chart gives it to its studies: forming while the clock is inside it
 *  (before its interval ends and before its session closes; a daily or longer bar while its trading day runs). */
export function liveBarState(symbol: string, resolution: string, session: string, bars: ChartBar[]): BarState {
  const last = bars[bars.length - 1];
  const sessions = cachedSymbolSessions(symbol);
  if (!last || !sessions) return CLOSED_BARS;
  const now = Date.now();
  let forming: boolean;
  if (isDailyInterval(resolution)) {
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
 *  newest bar; its result and the bars it was given. `slot`: who asks (a script keeps one run per slot). */
export function runStudy(
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
    seedSymbol,
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
  // A study calculated on other sources (study on study): their values first, read by its source inputs.
  const specs = sourceSpecsOf(plain);
  if (!specs) return { result: calculate(given, plain, chart), bars: given };
  delete (plain as Record<string, unknown>)[SOURCES_KEY];
  const values = new Map<string, number[]>();
  for (const [name, spec] of Object.entries(specs)) values.set(name, sourceSpecValues(spec, bars, given, symbol, resolution, session, state, slot));
  setSourceResolver((name) => values.get(name) ?? null);
  try {
    return { result: calculate(given, plain, chart), bars: given };
  } finally {
    setSourceResolver(null);
  }
}

/** Values of a study's other source at the bars `given` (NaN where it has none): another study calculated on the
 *  same bars (its own sources first), or a compared symbol's price source (its bars loaded on the first request). */
function sourceSpecValues(spec: SourceSpec, bars: unknown[], given: Bar[], symbol: string, resolution: string, session: string, state: BarState, slot: string): number[] {
  if (spec.study) {
    const entry = getIndicatorEntry(spec.study.id);
    const def = entry?.plotConfig[spec.study.plot];
    if (!entry || !def) return given.map(() => NaN);
    const run = runStudy(entry, bars, spec.study.inputs, symbol, resolution, session, state, `${slot}|${spec.study.id}`);
    const plots = (run.result as { plots?: Record<string, { time: unknown; value?: number | null }[]> } | null)?.plots;
    return alignToBars(plots?.[def.id], run.bars);
  }
  if (spec.symbol) {
    const other = alertSymbols.bars(spec.symbol.symbol, resolution, resolution);
    if (!other) return given.map(() => NaN);
    const src = spec.symbol.source as Parameters<typeof priceOf>[1];
    return alignToBars(other.map((b) => ({ time: b.time, value: priceOf(b as unknown as OHLC, src) })), given);
  }
  return given.map(() => NaN);
}

export function indicatorOperandValue(symbol: string, op: Extract<Operand, { kind: "indicator" }>, resolution: string, session: string, price: number): number | null {
  const plot = op.plot ?? 0;
  const entry = getIndicatorEntry(op.indicatorId);
  const plotId = entry?.plotConfig[plot]?.id;
  // A shape, character, arrow or candle price of the study, else a line plot.
  const out = op.output ? outputByKey(entry, op.output) : undefined;
  if (!entry || (op.output ? !out : !plotId)) return null;
  const charted = chartBars(symbol, resolution, session);
  // An older alert has no inputs of its own: the charted study's value while
  // a chart shows the symbol on the alert's interval, else the factory inputs.
  if (!op.inputs && charted && !out) {
    const live = indicatorPlotValue(symbol, op.indicatorId, plot);
    if (live != null) return live;
  }
  let bars = charted ?? fetchedBars(symbol, resolution, session);
  if (!bars || bars.length === 0) {
    // Not fetched yet (the symbol just left the chart): fetch now.
    void pollDrawingBars(true);
    return null;
  }
  if (!charted && Number.isFinite(price)) {
    const last = bars[bars.length - 1];
    bars = [...bars.slice(0, -1), { ...last, close: price, high: Math.max(last.high, price), low: Math.min(last.low, price) }];
  }
  const last = bars[bars.length - 1];
  const inputs = op.inputs ?? entry.defaultInputs;
  const key = `${symbol}|${resolution}|${session}|${op.indicatorId}|${op.output ?? plot}|${JSON.stringify(inputs)}`;
  const sig = `${bars.length}|${last.time}|${last.close}`;
  const now = Date.now();
  const hit = indicatorValueCache.get(key);
  if (hit && (hit.sig === sig || now - hit.at < INDICATOR_COMPUTE_MS)) return hit.value;
  let value: number | null = null;
  try {
    const dense = bars.map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume ?? 0 }));
    const run = runStudy(entry, dense, inputs, symbol, resolution, session, liveBarState(symbol, resolution, session, bars));
    // An output other than a line plot: its value on the last bar (na when it has none there).
    value = out ? outputValue(run.result, out, [run.bars[run.bars.length - 1]?.time ?? last.time, last.time]) : lastPlotValue(run.result, plotId!);
  } catch (e) {
    console.warn(`[alerts] indicator compute failed for ${op.indicatorId}`, e);
  }
  // Not computed yet (a script's worker run): ask again at the next tick.
  indicatorValueCache.set(key, { sig: value === null ? "" : sig, at: now, value });
  return value;
}

/** Current value of a study operand on an interval and session, as the engine reads it (the alert dialog's default
 *  value for an output the chart's legend does not show). */
export function studyOperandValue(symbol: string, op: Extract<Operand, { kind: "indicator" }>, resolution: string, session: string): number | null {
  return indicatorOperandValue(symbol, op, resolution, session, chartLastPrice(symbol) ?? NaN);
}

// ── Study conditions ──
// An alert on a study's condition (alert_condition) reads the study as an
// indicator operand does: on the alert's symbol, interval and session, with
// the inputs saved on the alert, computed again when the bars change (at most
// once a second). The condition is read on the newest bar.
const conditionCache = new Map<string, { sig: string; at: number; value: boolean | null }>();

export function studyConditionNow(symbol: string, op: Extract<Operand, { kind: "indicator" }>, resolution: string, session: string, price: number): boolean | null {
  const entry = getIndicatorEntry(op.indicatorId);
  const id = op.condition?.id;
  if (!entry || !id) return null;
  const charted = chartBars(symbol, resolution, session);
  let bars = charted ?? fetchedBars(symbol, resolution, session);
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
export type AlertCallsRun = { seq: number; calls: StudyAlertCall[]; bars: Bar[]; given: ChartBar[]; result: unknown; newest: number };

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
/** A run of a script read for its alert() calls (`given`: the bars as charted). */
export function newCallsRun(calls: StudyAlertCall[], run: { result: unknown; bars: Bar[] }, given: ChartBar[]): AlertCallsRun {
  return { seq: ++callsRunSeq, calls, bars: run.bars, given, result: run.result, newest: resultNewestBar(run.result, calls, run.bars) };
}
const callsCache = new Map<string, { sig: string; at: number; value: AlertCallsRun | null }>();

export function studyAlertCallsNow(symbol: string, op: Extract<Operand, { kind: "indicator" }>, resolution: string, session: string, price: number): AlertCallsRun | null {
  const entry = getIndicatorEntry(op.indicatorId);
  if (!entry) return null;
  const charted = chartBars(symbol, resolution, session);
  let bars = charted ?? fetchedBars(symbol, resolution, session);
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
    else if (calls) value = newCallsRun(calls, run, bars);
  } catch (e) {
    console.warn(`[alerts] alert() calls failed for ${op.indicatorId}`, e);
  }
  // Not computed yet (worker run): ask again at the next tick.
  callsCache.set(key, { sig: value === null ? "" : sig, at: now, value });
  return value;
}

/** The alert() calls of a run on closed bars, with the times of `bars`; waits (up to `waitMs`) for a script run in
 *  its worker. */
export async function alertCallSeries(op: Extract<Operand, { kind: "indicator" }>, bars: ChartBar[], rule: AlertRule, session: string, waitMs = 30_000): Promise<StudyAlertCall[] | null> {
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
export async function conditionSeries(op: Extract<Operand, { kind: "indicator" }>, bars: ChartBar[], rule: AlertRule, session: string, waitMs = 30_000): Promise<boolean[] | null> {
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
export async function pollDrawingBars(onlyMissing = false): Promise<void> {
  if (drawingPollBusy) return;
  const jobs = new Map<string, { symbol: string; resolution: string; session: SessionId }>();
  for (const rule of engineRules().flatMap(conditionRules)) {
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

/** The fetched bars of a symbol + interval + session, when a rule needs them. */
export function fetchedBars(symbol: string, resolution: string, session: string): ChartBar[] | null {
  return drawingBarsCache.get(`${symbol}|${resolution}|${session}`) ?? null;
}

/** Forget the computed study values: the rules that are left compute theirs again. */
export function clearStudyCaches(): void {
  indicatorValueCache.clear();
  conditionCache.clear();
  callsCache.clear();
}

/** Value of a study's plot at the close of every bar. */
export function plotSeries(op: Extract<Operand, { kind: "indicator" }>, bars: ChartBar[], rule: AlertRule, session: string): (number | null)[] | null {
  const entry = getIndicatorEntry(op.indicatorId);
  const plotId = entry?.plotConfig[op.plot ?? 0]?.id;
  const out = op.output ? outputByKey(entry, op.output) : undefined;
  if (!entry || (op.output ? !out : !plotId)) return null;
  try {
    const dense = bars.map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume ?? 0 }));
    const run = runStudy(entry, dense, op.inputs ?? entry.defaultInputs, rule.symbol, rule.resolution, session);
    // An output other than a line plot: its value on each bar.
    if (out) return outputSeries(run.result, out, bars.map((b, i) => [run.bars[i]?.time ?? b.time, b.time]));
    const result = run.result as { plots?: Record<string, Array<{ value: number | null }>> };
    const series = result.plots?.[plotId!];
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
