/*
 * Main-thread host for the backtest worker. Runs never block the UI
 * (priority 2): a run that overruns its deadline terminates the worker, and a
 * newer request for the same channel supersedes the pending one (its promise
 * resolves with null).
 */
import BacktestWorkerCtor from './worker?worker';
import type { BacktestError, BacktestOutput, BacktestRequest, BacktestResponse } from './worker-types';

export type { BacktestError };

const RUN_TIMEOUT_MS = 20_000;

export class BacktestFailed extends Error {
  constructor(readonly detail: BacktestError) {
    super(detail.message);
  }
}

type Pending = {
  channel: string;
  resolve: (output: BacktestOutput | null) => void;
  reject: (err: BacktestFailed) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class BacktestClient {
  private worker: Worker | null = null;
  private pending = new Map<number, Pending>();
  private seq = 0;

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new BacktestWorkerCtor();
    worker.onmessage = (e: MessageEvent<BacktestResponse>) => {
      const p = this.pending.get(e.data.id);
      if (!p) return; // superseded or timed out
      this.pending.delete(e.data.id);
      clearTimeout(p.timer);
      if (e.data.ok) p.resolve({ report: e.data.report, visuals: e.data.visuals });
      else p.reject(new BacktestFailed(e.data.error));
    };
    worker.onerror = () => this.restart('The backtest worker crashed.');
    this.worker = worker;
    return worker;
  }

  private restart(reason: string): void {
    this.worker?.terminate();
    this.worker = null;
    const failed = [...this.pending.values()];
    this.pending.clear();
    for (const p of failed) {
      clearTimeout(p.timer);
      p.reject(new BacktestFailed({ message: reason }));
    }
  }

  /**
   * Run a backtest. `channel` identifies the consumer (e.g. a chart id): a
   * newer run on the same channel resolves the older one with null.
   */
  run(channel: string, req: Omit<BacktestRequest, 'id'>): Promise<BacktestOutput | null> {
    for (const [id, p] of this.pending) {
      if (p.channel !== channel) continue;
      this.pending.delete(id);
      clearTimeout(p.timer);
      p.resolve(null);
    }
    const worker = this.ensureWorker();
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.restart(`The backtest did not finish within ${RUN_TIMEOUT_MS / 1000}s and was stopped.`);
        reject(new BacktestFailed({ message: `Timed out after ${RUN_TIMEOUT_MS / 1000}s.` }));
      }, RUN_TIMEOUT_MS);
      this.pending.set(id, { channel, resolve, reject, timer });
      worker.postMessage({ id, ...req } satisfies BacktestRequest);
    });
  }
}

let shared: BacktestClient | null = null;
export function getBacktestClient(): BacktestClient {
  return (shared ??= new BacktestClient());
}
