/*
 * OakEngine — main-thread host for the OakScript execution worker.
 *
 * Owns the worker lifecycle and the watchdog: every request carries a
 * deadline, and a request that overruns it (user infinite loop, wedged
 * worker) terminates and discards the whole worker — the UI thread never
 * blocks on user code (priority 2). The next request spawns a fresh worker;
 * compiled scripts are re-compiled on demand since the cache died with it.
 *
 * The worker chunk (monaco-sized nothing — just oakscriptjs, ~100 KB) is
 * fetched lazily on the first request.
 */
import OakWorkerCtor from "./oakscript-worker?worker";
import type { OakBacktestError, OakBar, OakCompiledMeta, OakRequest, OakResponse, OakScriptError } from "./engine-types";
import type { ChartContext } from "oakscriptjs/script";
import type { StrategyProperties } from "../../backtester/types";
import type { BacktestOutput } from "../../backtester/worker-types";

export type { OakBacktestError, OakBar, OakCompiledMeta, OakScriptError };

const COMPILE_TIMEOUT_MS = 10_000;
const RUN_TIMEOUT_MS = 5_000;
/** Same budget as the backtest worker of the strategy ports. */
const BACKTEST_TIMEOUT_MS = 20_000;

export class OakEngineError extends Error {
  constructor(
    public readonly detail: OakBacktestError,
    /** True when the worker was killed (timeout/crash) rather than the
     *  script failing normally — compiled state was lost. */
    public readonly fatal: boolean = false,
  ) {
    super(detail.message);
  }
}

type Pending = {
  resolve: (res: OakResponse) => void;
  reject: (err: OakEngineError) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class OakEngine {
  private worker: Worker | null = null;
  private pending = new Map<number, Pending>();
  private seq = 0;
  private gen = 0;

  /** Worker generation: bumped when the worker is killed, so callers know
   *  their compiled scripts are gone. */
  get generation(): number {
    return this.gen;
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new OakWorkerCtor();
    worker.onmessage = (e: MessageEvent<OakResponse>) => {
      const p = this.pending.get(e.data.id);
      if (!p) return;
      this.pending.delete(e.data.id);
      clearTimeout(p.timer);
      p.resolve(e.data);
    };
    worker.onerror = () => this.restart("The script worker crashed.");
    this.worker = worker;
    return worker;
  }

  /** Kill the worker and fail everything in flight. */
  private restart(reason: string): void {
    this.worker?.terminate();
    this.worker = null;
    this.gen++;
    const failed = [...this.pending.values()];
    this.pending.clear();
    for (const p of failed) {
      clearTimeout(p.timer);
      p.reject(new OakEngineError({ message: reason }, true));
    }
  }

  private request(msg: OakRequest, timeoutMs: number): Promise<OakResponse> {
    const worker = this.ensureWorker();
    return new Promise<OakResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(msg.id);
        // Watchdog: only a terminate can stop a busy-looping script.
        this.restart(`Script did not finish within ${Math.round(timeoutMs / 1000)}s and was stopped.`);
        reject(new OakEngineError({ message: `Timed out after ${Math.round(timeoutMs / 1000)}s.` }, true));
      }, timeoutMs);
      this.pending.set(msg.id, { resolve, reject, timer });
      worker.postMessage(msg);
    });
  }

  /** Compile `source` as scriptId; resolves with the script's declarative
   *  meta, rejects with OakEngineError carrying line/col when available. */
  async compile(scriptId: string, source: string): Promise<OakCompiledMeta> {
    const res = await this.request(
      { id: ++this.seq, type: "compile", scriptId, source },
      COMPILE_TIMEOUT_MS,
    );
    if (res.type !== "compile") throw new OakEngineError({ message: "Protocol mismatch." }, true);
    if (!res.ok) throw new OakEngineError(res.error);
    return res.meta;
  }

  /** Run a previously compiled script over `bars`. Returns the raw
   *  IndicatorResult-shaped object the script produced (validated by the
   *  chart layer in phase 6). */
  async run(scriptId: string, bars: OakBar[], inputs?: Record<string, unknown>, chart?: ChartContext): Promise<unknown> {
    const res = await this.request(
      { id: ++this.seq, type: "run", scriptId, bars, inputs, chart },
      RUN_TIMEOUT_MS,
    );
    if (res.type !== "run") throw new OakEngineError({ message: "Protocol mismatch." }, true);
    if (!res.ok) throw new OakEngineError(res.error);
    return res.result;
  }

  /** Backtest a compiled strategy script over `bars` on the OpenTrader broker.
   *  `properties` overrides the script's strategy() properties. */
  async backtest(
    scriptId: string,
    bars: OakBar[],
    inputs?: Record<string, unknown>,
    properties?: Partial<StrategyProperties>,
    chart?: ChartContext,
  ): Promise<BacktestOutput> {
    const res = await this.request(
      { id: ++this.seq, type: "backtest", scriptId, bars, inputs, properties, chart },
      BACKTEST_TIMEOUT_MS,
    );
    if (res.type !== "backtest") throw new OakEngineError({ message: "Protocol mismatch." }, true);
    if (!res.ok) throw new OakEngineError(res.error);
    return { report: res.report, visuals: res.visuals };
  }

  dispose(): void {
    this.restart("Engine disposed.");
  }
}

/** App-wide engine — the editor panel and every chart share one worker so a
 *  script compiled on save is already hot when the chart runs it. Never
 *  disposed; the watchdog replaces the worker on failure. */
let shared: OakEngine | null = null;
export function getOakEngine(): OakEngine {
  return (shared ??= new OakEngine());
}
