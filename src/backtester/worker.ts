/*
 * Backtest worker: runs a strategy port over bars off the UI thread.
 * One request = one full run; the client supersedes older requests.
 */
import { StrategyRuntimeError } from './broker';
import { runBacktest } from './run';
import { STRATEGIES } from './strategies';
import type { BacktestRequest, BacktestResponse } from './worker-types';

self.onmessage = (e: MessageEvent<BacktestRequest>) => {
  const req = e.data;
  const def = STRATEGIES.find((s) => s.key === req.strategy);
  let res: BacktestResponse;
  if (!def) {
    res = { id: req.id, ok: false, error: { message: `Unknown strategy "${req.strategy}".` } };
  } else {
    try {
      const report = runBacktest(req.bars, def, { inputs: req.inputs, properties: req.properties, symbol: req.symbol });
      res = { id: req.id, ok: true, report };
    } catch (err) {
      res =
        err instanceof StrategyRuntimeError
          ? { id: req.id, ok: false, error: { message: err.message, code: err.code, bar: err.bar } }
          : { id: req.id, ok: false, error: { message: err instanceof Error ? err.message : String(err) } };
    }
  }
  (self as unknown as Worker).postMessage(res);
};
