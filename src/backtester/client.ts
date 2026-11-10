/*
 * Main-thread host for the backtest worker. Runs never block the UI
 * (priority 2): a run that overruns its deadline terminates the worker, and a
 * newer request for the same channel supersedes the pending one (its promise
 * resolves with null).
 *
 * Bar magnifier (properties.barMagnifier): the lower-timeframe bars are
 * fetched here (intrabars.ts) and sent to the worker once per version; later
 * runs only name the series the worker keeps.
 *
 * A live run (a strategy on a chart, `opts.live`) keeps its bars in the
 * worker: a request sends the bars that changed since the channel's previous
 * one (live-runs.ts).
 */
import { intrabarsRef } from './intrabars';
import { translateWith } from '../i18n/translator';
import { SentRuns } from './live-runs';
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
  /** A live request: posts it again with all the bars (the worker no longer had the ones it counted on). */
  resend?: () => void;
};

export class BacktestClient {
  private worker: Worker | null = null;
  private pending = new Map<number, Pending>();
  private seq = 0;
  /** Latest run ticket per channel: a run still fetching magnifier data when a newer one starts resolves null. */
  private tickets = new Map<string, number>();
  private ticket = 0;
  /** Magnifier series version already sent to the current worker, by key. */
  private sent = new Map<string, number>();
  /** Bars and drawn outputs of the live runs, by channel. */
  private live = new SentRuns();

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new BacktestWorkerCtor();
    worker.onmessage = (e: MessageEvent<BacktestResponse>) => {
      const p = this.pending.get(e.data.id);
      if (!p) return; // superseded or timed out
      this.pending.delete(e.data.id);
      clearTimeout(p.timer);
      const res = e.data;
      if (res.ok) {
        if (!res.live) p.resolve({ report: res.report, visuals: res.visuals });
        else p.resolve({ report: res.report, visuals: this.live.received(p.channel, res.visuals, res.live), fullRunReason: res.live.fullRunReason });
      } else if ('resend' in res && p.resend) {
        p.resend();
      } else {
        this.live.forget(p.channel);
        p.reject(new BacktestFailed(res.error));
      }
    };
    worker.onerror = () => this.restart('The backtest worker crashed.');
    this.worker = worker;
    return worker;
  }

  private restart(reason: string): void {
    this.worker?.terminate();
    this.worker = null;
    this.sent.clear();
    this.live.clear();
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
   * `magnify`: the effective bar magnifier property (the script's declaration
   * when the properties do not override it). `live`: the worker keeps the
   * channel's run (a strategy on a chart; `req.bars` not changed afterwards).
   */
  async run(channel: string, req: Omit<BacktestRequest, 'id' | 'intrabars' | 'live'>, opts: { magnify?: boolean; live?: boolean } = {}): Promise<BacktestOutput | null> {
    const ticket = ++this.ticket;
    this.tickets.set(channel, ticket);
    const magnify = opts.magnify ?? req.properties?.barMagnifier === true;
    const intrabars = await intrabarsRef(magnify, req.heikinAshi, req.bars, req.chart, this.sent);
    if (this.tickets.get(channel) !== ticket) return null;
    return this.post(channel, { ...req, intrabars }, opts.live === true);
  }

  private post(channel: string, req: Omit<BacktestRequest, 'id' | 'live'>, live: boolean): Promise<BacktestOutput | null> {
    for (const [id, p] of this.pending) {
      if (p.channel !== channel) continue;
      this.pending.delete(id);
      clearTimeout(p.timer);
      p.resolve(null);
    }
    return new Promise((resolve, reject) => {
      const send = (whole: boolean) => {
        const worker = this.ensureWorker();
        const id = ++this.seq;
        const sent = live ? this.live.request(channel, req.bars, whole) : null;
        const timer = setTimeout(() => {
          this.pending.delete(id);
          this.restart(`The backtest did not finish within ${RUN_TIMEOUT_MS / 1000}s and was stopped.`);
          reject(new BacktestFailed({ message: translateWith('Timed out after {0}s.', RUN_TIMEOUT_MS / 1000) }));
        }, RUN_TIMEOUT_MS);
        this.pending.set(id, { channel, resolve, reject, timer, resend: sent && !whole ? () => send(true) : undefined });
        worker.postMessage({ id, ...req, ...(sent ? { bars: sent.bars, live: sent.live } : {}) } satisfies BacktestRequest);
        if (req.intrabars?.bars) this.sent.set(req.intrabars.key, req.intrabars.version);
      };
      send(false);
    });
  }
}

let shared: BacktestClient | null = null;
export function getBacktestClient(): BacktestClient {
  return (shared ??= new BacktestClient());
}
