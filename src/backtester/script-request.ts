/*
 * One OakScript strategy request, run the same way by both workers that take it: the backtest worker (the
 * strategies the app ships) and the script editor's worker (a user's compiled script).
 */
import { runOakScriptStrategy, type OakScriptRunOptions } from './oakscript';
import { intrabarsOf } from './intrabar-cache';
import { intervalSeconds } from './magnifier';
import { updateLiveStrategy, type KeptRuns, type KeptStrategy, type LiveReply } from './live-runs';
import type { BacktestReport } from './types';
import type { BacktestRequest } from './worker-types';

/** The fields of a request a script strategy runs on. */
export type ScriptRunRequest = Pick<BacktestRequest, 'bars' | 'inputs' | 'properties' | 'symbol' | 'chart' | 'intrabars' | 'heikinAshi' | 'symbols' | 'live'>;

/**
 * The strategy `body` on the request: its report (undefined when the script declared no strategy or never ran
 * strategy.eachBar()) and drawn outputs. A live request keeps its run in `kept`; null: the worker no longer has the
 * bars it counts on (the host sends them all again).
 */
export function runScriptRequest(
  kept: KeptRuns<KeptStrategy | null>,
  body: () => void,
  req: ScriptRunRequest,
): { report?: BacktestReport; visuals: unknown; live?: LiveReply } | null {
  const opts: OakScriptRunOptions = {
    inputs: req.inputs,
    properties: req.properties,
    symbol: req.symbol,
    chart: req.chart,
    intrabars: intrabarsOf(req.intrabars),
    intrabarSeconds: req.intrabars ? intervalSeconds(req.intrabars.interval) : undefined,
    heikinAshi: req.heikinAshi,
    symbols: req.symbols,
  };
  if (req.live) return updateLiveStrategy(kept, req.live, body, req.bars, opts);
  const { report, script } = runOakScriptStrategy(body, req.bars, opts);
  // The kinds of drawings the run created ride with the drawn outputs (the Style tab lists one row per kind).
  return { report, visuals: script.drawingKinds.length ? { ...script.result, drawingKinds: script.drawingKinds } : script.result };
}
