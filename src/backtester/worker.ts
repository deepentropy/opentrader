/*
 * Backtest worker: runs a strategy (a TypeScript port or an OakScript script)
 * over bars off the UI thread. One request = one full run; the client
 * supersedes older requests.
 */
import { StrategyRuntimeError } from './broker';
import { runOakScriptStrategy } from './oakscript';
import { runBacktest } from './run';
import { SCRIPT_STRATEGIES } from './scripts';
import { STRATEGIES } from './strategies';
import type { BacktestReport } from './types';
import type { BacktestRequest, BacktestResponse } from './worker-types';

function runStrategy(req: BacktestRequest): BacktestReport | string {
  const def = STRATEGIES.find((s) => s.key === req.strategy);
  if (def) return runBacktest(req.bars, def, { inputs: req.inputs, properties: req.properties, symbol: req.symbol });
  const script = SCRIPT_STRATEGIES.find((s) => s.key === req.strategy);
  if (!script) return `Unknown strategy "${req.strategy}".`;
  const { report } = runOakScriptStrategy(script.body, req.bars, {
    inputs: req.inputs,
    properties: req.properties,
    symbol: req.symbol,
    chart: req.chart,
  });
  return report ?? `Strategy "${req.strategy}" did not run.`;
}

self.onmessage = (e: MessageEvent<BacktestRequest>) => {
  const req = e.data;
  let res: BacktestResponse;
  try {
    const out = runStrategy(req);
    res = typeof out === 'string' ? { id: req.id, ok: false, error: { message: out } } : { id: req.id, ok: true, report: out };
  } catch (err) {
    res =
      err instanceof StrategyRuntimeError
        ? { id: req.id, ok: false, error: { message: err.message, code: err.code, bar: err.bar } }
        : { id: req.id, ok: false, error: { message: err instanceof Error ? err.message : String(err) } };
  }
  (self as unknown as Worker).postMessage(res);
};
