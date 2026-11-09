/*
 * Backtest worker: runs a strategy (a TypeScript port or an OakScript script)
 * over bars off the UI thread; the client supersedes older requests. A
 * strategy on a chart keeps its run here (live-runs.ts): a live update sends
 * the changed bars only, and an OakScript strategy calculates the newest bars
 * when it can.
 */
import { MissingSymbolDataError } from 'oakscriptjs/script';
import { StrategyRuntimeError } from './broker';
import { symbolOf } from './oakscript';
import { runScriptRequest } from './script-request';
import { runBacktest } from './run';
import { SCRIPT_STRATEGIES } from './scripts';
import { BUILTIN_STRATEGIES } from './builtins';
import { provideTechnicalRatings, TECHNICAL_RATINGS_KEY } from './builtins/technical-ratings';
import { STRATEGIES } from './strategies';
import type { BacktestOutput, BacktestRequest, BacktestResponse } from './worker-types';
import { intervalSeconds } from './magnifier';
import { intrabarsOf } from './intrabar-cache';
// The chart's library studies calculate in this worker too (it carries the library already).
import { calculateStudy, isStudyJob } from '../window/chart/indicators/study-calc';
import { KeptRuns, type KeptStrategy, type LiveReply } from './live-runs';

/** The strategies on the charts, by channel (a port keeps its bars only). */
const live = new KeptRuns<KeptStrategy | null>();

/** The output of a request; null: a live request whose bars the worker no longer has. */
function runStrategy(req: BacktestRequest): (Omit<BacktestOutput, 'fullRunReason'> & { live?: LiveReply }) | string | null {
  const def = STRATEGIES.find((s) => s.key === req.strategy);
  if (def) {
    const intrabars = intrabarsOf(req.intrabars);
    const intrabarSeconds = req.intrabars ? intervalSeconds(req.intrabars.interval) : undefined;
    const common = { intrabars, intrabarSeconds, heikinAshi: req.heikinAshi, realtime: req.chart?.realtime === true };
    // syminfo.timezone / mintick of the port = the charted symbol's.
    const symbol = { ...symbolOf(req.chart), ...req.symbol };
    const got = req.live ? live.bars(req.live, req.bars) : { kept: undefined, bars: req.bars };
    if (!got) return null;
    const report = runBacktest(got.bars, def, { inputs: req.inputs, properties: req.properties, symbol, ...common });
    // A port calculates every bar: its bars are kept for the changed bars of the next request.
    return req.live ? { report, live: live.keep(req.live, got.kept, got.bars, null, undefined, null).live } : { report };
  }
  const script = SCRIPT_STRATEGIES.find((s) => s.key === req.strategy) ?? BUILTIN_STRATEGIES.find((s) => s.key === req.strategy);
  if (!script) return `Unknown strategy "${req.strategy}".`;
  const out = runScriptRequest(live, script.body, req);
  if (!out) return null;
  if (!out.report) return `Strategy "${req.strategy}" did not run.`;
  return { report: out.report, visuals: out.visuals, ...(out.live ? { live: out.live } : {}) };
}

/** The indicator library, loaded once by the first run that needs it (Technical ratings strategy). */
let ratingsLoaded: Promise<void> | null = null;
function loadRatings(): Promise<void> {
  ratingsLoaded ??= import('lightweight-charts-indicators').then((lib) => provideTechnicalRatings(lib.calculateTechnicalRatingsStandard));
  return ratingsLoaded;
}

self.onmessage = async (e: MessageEvent<BacktestRequest>) => {
  if (isStudyJob(e.data)) {
    (self as unknown as Worker).postMessage(await calculateStudy(e.data));
    return;
  }
  const req = e.data;
  let res: BacktestResponse;
  try {
    if (req.strategy === TECHNICAL_RATINGS_KEY) await loadRatings();
    const out = runStrategy(req);
    res =
      out === null
        ? { id: req.id, ok: false, resend: true, error: { message: 'The worker no longer has the bars of this run.' } }
        : typeof out === 'string'
          ? { id: req.id, ok: false, error: { message: out } }
          : { id: req.id, ok: true, ...out };
  } catch (err) {
    res =
      err instanceof StrategyRuntimeError
        ? { id: req.id, ok: false, error: { message: err.message, code: err.code, bar: err.bar } }
        : err instanceof MissingSymbolDataError
          ? { id: req.id, ok: false, error: { message: err.message, missing: err.requests.map((r) => ({ symbol: r.symbol, timeframe: r.timeframe })) } }
          : { id: req.id, ok: false, error: { message: err instanceof Error ? err.message : String(err) } };
  }
  (self as unknown as Worker).postMessage(res);
};
