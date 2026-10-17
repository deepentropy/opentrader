/*
 * Backtest worker: runs a strategy (a TypeScript port or an OakScript script)
 * over bars off the UI thread. One request = one full run; the client
 * supersedes older requests.
 */
import { MissingSymbolDataError } from 'oakscriptjs/script';
import { StrategyRuntimeError } from './broker';
import { runOakScriptStrategy, symbolOf } from './oakscript';
import { runBacktest } from './run';
import { SCRIPT_STRATEGIES } from './scripts';
import { BUILTIN_STRATEGIES } from './builtins';
import { provideTechnicalRatings, TECHNICAL_RATINGS_KEY } from './builtins/technical-ratings';
import { STRATEGIES } from './strategies';
import type { BacktestOutput, BacktestRequest, BacktestResponse } from './worker-types';
import { intervalSeconds } from './magnifier';
import { intrabarsOf } from './intrabar-cache';

function runStrategy(req: BacktestRequest): BacktestOutput | string {
  const intrabars = intrabarsOf(req.intrabars);
  const intrabarSeconds = req.intrabars ? intervalSeconds(req.intrabars.interval) : undefined;
  const common = { intrabars, intrabarSeconds, heikinAshi: req.heikinAshi, realtime: req.chart?.realtime === true };
  const def = STRATEGIES.find((s) => s.key === req.strategy);
  if (def) {
    // syminfo.timezone / mintick of the port = the charted symbol's.
    const symbol = { ...symbolOf(req.chart), ...req.symbol };
    return { report: runBacktest(req.bars, def, { inputs: req.inputs, properties: req.properties, symbol, ...common }) };
  }
  const script = SCRIPT_STRATEGIES.find((s) => s.key === req.strategy) ?? BUILTIN_STRATEGIES.find((s) => s.key === req.strategy);
  if (!script) return `Unknown strategy "${req.strategy}".`;
  const { report, script: run } = runOakScriptStrategy(script.body, req.bars, {
    inputs: req.inputs,
    properties: req.properties,
    symbol: req.symbol,
    chart: req.chart,
    intrabars,
    intrabarSeconds,
    heikinAshi: req.heikinAshi,
    symbols: req.symbols,
  });
  // The kinds of drawings the run created ride with the drawn outputs (the Style tab lists one row per kind).
  return report ? { report, visuals: run.drawingKinds.length ? { ...run.result, drawingKinds: run.drawingKinds } : run.result } : `Strategy "${req.strategy}" did not run.`;
}

/** The indicator library, loaded once by the first run that needs it (Technical ratings strategy). */
let ratingsLoaded: Promise<void> | null = null;
function loadRatings(): Promise<void> {
  ratingsLoaded ??= import('lightweight-charts-indicators').then((lib) => provideTechnicalRatings(lib.calculateTechnicalRatingsStandard));
  return ratingsLoaded;
}

self.onmessage = async (e: MessageEvent<BacktestRequest>) => {
  const req = e.data;
  let res: BacktestResponse;
  try {
    if (req.strategy === TECHNICAL_RATINGS_KEY) await loadRatings();
    const out = runStrategy(req);
    res = typeof out === 'string' ? { id: req.id, ok: false, error: { message: out } } : { id: req.id, ok: true, ...out };
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
