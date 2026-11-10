/*
 * The bars missed while the app was not running. The backend replays its own
 * rules (alert-backend.ts). The rules evaluated in the window are read again
 * at start, bar by bar on their interval and session (alert-replay.ts); what
 * they find goes to the log and the rule's webhook only, as fires that
 * happened while the app was closed. The web build does the same at each
 * visit, from the last quotes it kept (alert-backend.ts).
 */
import { getBars, isSupportedResolution } from "./datafeed";
import { symbolSessions } from "./session";
import type { SessionId } from "./session/symbol-sessions";
import { conditionRules, drawingBand, drawingPriceLevel, drawingTime, drawingVwapValue, isBandOperator, isMovingOperator, isStrategyOperator, ruleQuoteSymbol } from "./alert-condition";
import type { AlertRule } from "./alert-store";
import type { ChartBar } from "./chart-state-registry";
import { evaluatedByBackend, previousRunQuotes } from "./alert-backend";
import { isEventOperator, REPLAY_MAX_FIRES, REPLAY_MAX_SEC, replayAlertCalls, replayCondition, replayConditions, replayRule, ruleFlags, type ReplayConditionSeries } from "./alert-replay";
import { strategyFillsBetween } from "./alert-strategy";
import { DEFAULT_SESSION, engineRules, resolutionMs } from "./alert-bars";
import { alertCallSeries, conditionSeries, plotSeries } from "./alert-studies";
import { deliverFire } from "./alert-delivery";
import { deliverStrategyFill, fillBarTime, strategyReplayReport } from "./alert-strategies";
import { loadIndicatorLibrary } from "../window/chart/indicators/registry";
import * as kv from "./kv";
import { isDailyInterval } from "./interval";

/** The previous run whose missed bars were read (they are read once). */
const REPLAYED_KEY = "alerts.replayed-run.v1";

/** The moment each bar closes (UNIX seconds), for conditions on several intervals read together: an intraday bar at
 *  its end or its session's end; a daily or longer bar at the end of the last session it covers. */
async function barCloses(symbol: string, resolution: string, session: SessionId, bars: ChartBar[]): Promise<number[]> {
  const stepSec = resolutionMs(resolution) / 1000;
  const spec = await symbolSessions(symbol).then((s) => s.spec(session), () => null);
  const long = isDailyInterval(resolution);
  return bars.map((b, i) => {
    const end = Math.min(b.time + stepSec, bars[i + 1]?.time ?? Infinity);
    if (!spec) return end;
    if (long) return spec.previous(end)?.end ?? end;
    const iv = spec.currentOrNext(b.time);
    return iv && iv.start <= b.time ? Math.min(end, iv.end) : end;
  });
}

/** What one condition reads for the replay, on the bars of its interval: the operands' values at each bar's close
 *  (`left` null: the price), or per bar whether it holds (`flags`: a study's own condition, the crossing of a
 *  vertical line). */
type ReplayInputs = { bars: ChartBar[]; stepSec: number; left: (number | null)[] | null; right: (number | null)[]; lower: (number | null)[] | null; flags?: boolean[] };

/** The inputs of `rule`'s condition for the replay from `from` (UNIX seconds); null when it cannot be read. `drawings`:
 *  the price levels and channels of drawings too (a single condition on them is replayed by the backend). */
async function replayInputs(rule: AlertRule, barsBy: Map<string, ChartBar[]>, session: SessionId, from: number, drawings: boolean): Promise<ReplayInputs | null> {
  const { left, right } = rule;
  const right2 = rule.right2;
  const stepSec = resolutionMs(rule.resolution) / 1000;
  if (rule.op === "alert_condition") {
    if (left.kind !== "indicator") return null;
    const bars = await replayBars(barsBy, rule.symbol, rule.resolution, session);
    if (!bars) return null;
    const flags = await conditionSeries(left, bars, rule, session);
    return flags ? { bars, stepSec, left: null, right: [], lower: null, flags } : null;
  }
  // A compared symbol's price: its own bars.
  const quoteSymbol = ruleQuoteSymbol(rule);
  const quoteBars = await replayBars(barsBy, quoteSymbol, rule.resolution, session);
  if (!quoteBars) return null; // no bars: nothing to read
  // A compared symbol against the chart symbol's price or studies: those are read on the chart symbol's bars, at
  // the bars both symbols have.
  const ownBars = quoteSymbol === rule.symbol ? quoteBars : await replayBars(barsBy, rule.symbol, rule.resolution, session);
  if (!ownBars) return null;
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
  /** The close of bar i (now for the bar in progress). */
  const closeAt = (i: number) => Math.min(bars[i].time + stepSec, bars[i + 1]?.time ?? Infinity, Date.now() / 1000);
  // A compared symbol as the source: the bars read are its own (its price).
  const leftSeries = left.kind === "indicator" ? plotSeries(left, bars, rule, session) : null;
  if (left.kind === "indicator" && !leftSeries) return null;
  let rightSeries: (number | null)[] | null;
  let lowerSeries: (number | null)[] | null = null;
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
  } else if (right.kind === "drawing" && drawings) {
    if (right.band === "position") return null;
    if (right.band === "time") {
      // A vertical line: crossed in the bar its time falls in.
      const t = drawingTime(rule.symbol, right.drawingId);
      if (t == null) return null;
      return { bars, stepSec, left: null, right: [], lower: null, flags: bars.map((b, i) => b.time <= t && t < closeAt(i)) };
    }
    if (right.band === "channel" || right.band === "rectangle") {
      // Its two bounds where they stand at each bar's close.
      const bounds = bars.map((_, i) => drawingBand(rule.symbol, right.drawingId, closeAt(i), right.level, right.level2));
      rightSeries = bounds.map((b) => b?.upper ?? null);
      lowerSeries = bounds.map((b) => b?.lower ?? null);
    } else rightSeries = bars.map((_, i) => drawingPriceLevel(rule.symbol, right.drawingId, closeAt(i), right.level));
  } else return null;
  if (!rightSeries) return null;
  // Channel between two bounds: the lower one.
  if (right2 && isBandOperator(rule.op)) {
    if (right2.kind === "indicator") lowerSeries = aligned(plotSeries(right2, ownBars, rule, session));
    else if (right2.kind === "value") lowerSeries = bars.map(() => right2.value);
    else if (right2.kind === "price") lowerSeries = aligned(ownBars.map((b) => b.close));
    else if (right2.kind === "symbol") lowerSeries = await symbolSeries(right2.symbol);
    if (!lowerSeries) return null;
  }
  return { bars, stepSec, left: leftSeries, right: rightSeries, lower: lowerSeries };
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
  for (const rule of engineRules()) {
    if (evaluatedByBackend(rule) || !isSupportedResolution(rule.resolution)) continue;
    // Several conditions read in the window: each on its own interval's bars, read together at every bar close.
    if (rule.and?.length) {
      const since = (rule.activeSince ?? rule.createdAt) / 1000;
      const from = Math.max(previous[ruleQuoteSymbol(rule)] ?? since, since, nowSec - REPLAY_MAX_SEC);
      if (nowSec - from < 60) continue;
      const session = rule.session ?? DEFAULT_SESSION;
      const conds: ReplayConditionSeries[] = [];
      for (const view of conditionRules(rule)) {
        // The bar closed before the first one read, for the state a condition is in when the replay starts.
        const step = resolutionMs(view.resolution) / 1000;
        const inp = await replayInputs(view, barsBy, session, from - step, true);
        if (!inp) break;
        const met = inp.flags ?? ruleFlags(view, inp.bars, inp.left, inp.right, from - step, inp.stepSec, inp.lower).map((p) => p != null);
        conds.push({ bars: inp.bars, stepSec: inp.stepSec, met, event: isEventOperator(view.op), closes: await barCloses(ruleQuoteSymbol(view), view.resolution, session, inp.bars) });
      }
      if (conds.length !== conditionRules(rule).length) continue; // a condition cannot be read: not replayed
      for (const f of replayConditions(rule, conds, conds[0].bars, conds[0].stepSec, from, nowSec)) {
        deliverFire(rule, f.price, f.barTime, { fireTime: f.fireTime });
        found++;
      }
      continue;
    }
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
    const inp = await replayInputs(rule, barsBy, session, from, false);
    if (!inp || inp.flags) continue;
    for (const f of replayRule(rule, inp.bars, inp.left, inp.right, from, nowSec, inp.stepSec, inp.lower)) {
      deliverFire(rule, f.price, f.barTime, { fireTime: f.fireTime });
      found++;
    }
  }
  return found;
}

/** Once per run of the app (a visit, on the web build): the fires missed while it was not running (with the indicator
 *  library loaded: alerts on its studies are replayed too). */
export function replayMissedOnce(): void {
  // Read at once: the web build's record is overwritten during this run.
  const previousRun = previousRunQuotes();
  void loadIndicatorLibrary()
    .then(() => previousRun)
    .then((recorded) => {
      // No record on the web build yet: from each rule's start, as the app does without a previous run.
      const previous = recorded ?? {};
      const run = JSON.stringify(previous);
      if (kv.getItem(REPLAYED_KEY) === run) return;
      kv.setItem(REPLAYED_KEY, run);
      return replayMissedFires(previous);
    })
    .catch((e) => console.warn("[alerts] missed bars not read", e));
}
