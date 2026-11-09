/*
 * Alerts on a script's alert() calls and on a strategy (its order fills and /
 * or its alert() calls), read on the runs of the script the studies module
 * makes (./alert-studies); their memory is the rule's (./alert-rule-state).
 */
import type { AlertRule, Operand } from "./alert-store";
import { chartBars, type ChartBar } from "./chart-state-registry";
import { getIndicatorEntry } from "../window/chart/indicators/registry";
import type { Bar } from "oakscriptjs";
import { newStrategyFills, type StrategyFillEvent } from "./alert-strategy";
import { strategyKeyOf } from "../window/chart/indicators/strategy-entries";
import { typeIdOf } from "../window/chart/indicators/study-id";
import { strategyTester } from "./strategy-tester-store";
import type { BacktestReport } from "../backtester/types";
import { alertCallsOf, type StudyAlertCall } from "./alert-study-conditions";
import { DEFAULT_SESSION } from "./alert-bars";
import { ALERTS_CHART, CLOSED_BARS, fetchedBars, INDICATOR_COMPUTE_MS, liveBarState, newCallsRun, pollDrawingBars, runStudy, studyAlertCallsNow, type AlertCallsRun } from "./alert-studies";
import { deliverFire } from "./alert-delivery";
import { ruleRuntimes } from "./alert-rule-state";

/** Fire the alert() calls of `rule` that the newest run allows. */
export function evaluateAlertCalls(rule: AlertRule, price: number): void {
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
  const runtime = ruleRuntimes.get(rule.id);
  const st = (runtime.calls ??= { bar: newest, once: false, seq: -1 });
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
export type StrategyAlertRun = { report: BacktestReport | null; calls: AlertCallsRun | null; bars: Bar[]; given: ChartBar[] };

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
  const slot = strategySlot(rule, op, "live");
  const sig = `${bars.length}|${last.time}|${last.close}|${last.high}|${last.low}`;
  const now = Date.now();
  const runtime = ruleRuntimes.get(rule.id);
  const hit = runtime.strategyRun;
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
    else if (calls) callsRun = newCallsRun(calls, run, bars);
    value = { report: slotReport(slot), calls: callsRun, bars: run.bars, given: bars };
  } catch (e) {
    console.warn(`[alerts] strategy run failed for ${op.indicatorId}`, e);
  }
  runtime.strategyRun = { sig: value === null ? "" : sig, at: now, value };
  return value;
}

/** The bar (chart time, UNIX ms) a strategy fill happened in: the bar of the strategy's bars at the fill's time. */
export function fillBarTime(fillTimeMs: number, bars: Bar[], given: ChartBar[]): number {
  const i = bars.findIndex((b) => (b.time as number) * 1000 === fillTimeMs);
  return i >= 0 && given[i] ? given[i].time * 1000 : fillTimeMs;
}

/** Fire the new order fills and the alert() calls of the strategy of `rule` (as its condition asks). */
export function evaluateStrategy(rule: AlertRule, price: number): void {
  const left = rule.left;
  if (left.kind !== "indicator") return;
  const run = strategyRunNow(rule, left, price);
  if (!run) return;
  if (rule.op !== "strategy_alerts" && run.report) {
    const newest = run.given[run.given.length - 1];
    const runtime = ruleRuntimes.get(rule.id);
    const { fire, state } = newStrategyFills(runtime.strategy, run.report, newest ? newest.time * 1000 : Date.now());
    runtime.strategy = state;
    for (const e of fire) deliverStrategyFill(rule, e, price, fillBarTime(e.fill.time, run.bars, run.given));
  }
  if (rule.op !== "strategy_orders" && run.calls) fireAlertCalls(rule, run.calls, price);
}

/** Deliver an order fill of a strategy alert: its message filled with the fill. The replay of the missed bars and the
 *  live reading run on different bars (other sizes) and may both find a fill of the bars just loaded: the rule's
 *  memory keeps the fills delivered (bar, order, side), so it is delivered once. */
export function deliverStrategyFill(rule: AlertRule, e: StrategyFillEvent, price: number, barTime: number, offline?: { fireTime: number }): void {
  const done = ruleRuntimes.get(rule.id).strategyDelivered;
  const key = `${barTime}|${e.fill.id}|${e.values.action}`;
  if (done.has(key)) return;
  done.add(key);
  if (done.size > 500) done.delete(done.values().next().value as string);
  deliverFire(rule, price, barTime, offline, undefined, { strategy: e.values });
}

/** The report of a strategy run on closed bars (the replay); waits (up to `waitMs`) for the worker's run. */
export async function strategyReplayReport(op: Extract<Operand, { kind: "indicator" }>, bars: ChartBar[], rule: AlertRule, session: string, waitMs = 60_000): Promise<{ report: BacktestReport; bars: Bar[]; calls: StudyAlertCall[] | null } | null> {
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
