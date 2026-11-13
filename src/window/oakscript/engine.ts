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
import type { OakBacktestError, OakBar, OakCompiledMeta, OakProfile, OakRequest, OakResponse, OakScriptError, OakSourceData, OakSymbolData } from "./engine-types";
import type { ChartContext } from "oakscriptjs/script";
import type { StrategyProperties } from "../../backtester/types";
import type { BacktestOutput } from "../../backtester/worker-types";
import { intrabarsRef } from "../../backtester/intrabars";
import { translateWith } from "../../i18n/translator";
import { SentRuns } from "../../backtester/live-runs";

export type { OakBacktestError, OakBar, OakCompiledMeta, OakProfile, OakScriptError };

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
  /** The script the request runs (the profile of its reply is that script's). */
  scriptId?: string;
  resolve: (res: OakResponse) => void;
  reject: (err: OakEngineError) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class OakEngine {
  private worker: Worker | null = null;
  private pending = new Map<number, Pending>();
  private seq = 0;
  private gen = 0;
  /** Bar magnifier series version already sent to the current worker, by key. */
  private sent = new Map<string, number>();
  /** The bars and results of the studies (`run:<run key>`) and strategies (`backtest:<run key>`) on the charts:
   *  the worker keeps them apart. */
  private live = new SentRuns();
  /** Scripts in profiler mode (#312): compiled with their timers. */
  private profiled = new Set<string>();
  private profileListeners = new Set<(scriptId: string, profile: OakProfile) => void>();

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
      const res = e.data;
      if (res.ok && "profile" in res && res.profile && "scriptId" in p) {
        for (const fn of this.profileListeners) fn(p.scriptId as string, res.profile);
      }
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
    this.sent.clear();
    this.live.clear();
    this.worker = null;
    this.gen++;
    const failed = [...this.pending.values()];
    this.pending.clear();
    for (const p of failed) {
      clearTimeout(p.timer);
      p.reject(new OakEngineError({ message: reason }, true));
    }
  }

  /** `onPosted` runs once the message is posted to the worker. */
  private request(msg: OakRequest, timeoutMs: number, onPosted?: () => void): Promise<OakResponse> {
    const worker = this.ensureWorker();
    return new Promise<OakResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(msg.id);
        // Watchdog: only a terminate can stop a busy-looping script.
        this.restart(`Script did not finish within ${Math.round(timeoutMs / 1000)}s and was stopped.`);
        reject(new OakEngineError({ message: translateWith("Timed out after {0}s.", Math.round(timeoutMs / 1000)) }, true));
      }, timeoutMs);
      this.pending.set(msg.id, { scriptId: msg.scriptId, resolve, reject, timer });
      worker.postMessage(msg);
      onPosted?.();
    });
  }

  /** Profiler mode of `scriptId` on or off: the next compile of it has the timers or not (the caller compiles it
   *  again). */
  setProfiled(scriptId: string, on: boolean): void {
    if (on) this.profiled.add(scriptId);
    else this.profiled.delete(scriptId);
  }

  isProfiled(scriptId: string): boolean {
    return this.profiled.has(scriptId);
  }

  /** `fn` gets the profile of each run of a script in profiler mode; returns the unsubscribe. */
  onProfile(fn: (scriptId: string, profile: OakProfile) => void): () => void {
    this.profileListeners.add(fn);
    return () => this.profileListeners.delete(fn);
  }

  /** Compile `source` as scriptId; resolves with the script's declarative
   *  meta, rejects with OakEngineError carrying line/col when available. */
  async compile(scriptId: string, source: string): Promise<OakCompiledMeta> {
    const profile = this.profiled.has(scriptId);
    const res = await this.request(
      { id: ++this.seq, type: "compile", scriptId, source, ...(profile ? { profile } : {}) },
      COMPILE_TIMEOUT_MS,
    );
    if (res.type !== "compile") throw new OakEngineError({ message: "Protocol mismatch." }, true);
    if (!res.ok) throw new OakEngineError(res.error);
    return res.meta;
  }

  /** Run a previously compiled script over `bars`. Returns the raw
   *  IndicatorResult-shaped object the script produced (validated by the
   *  chart layer in phase 6). */
  async run(scriptId: string, bars: OakBar[], inputs?: Record<string, unknown>, chart?: ChartContext, symbols?: OakSymbolData, sources?: OakSourceData): Promise<unknown> {
    const res = await this.request(
      { id: ++this.seq, type: "run", scriptId, bars, inputs, chart, symbols, ...(sources ? { sources } : {}) },
      RUN_TIMEOUT_MS,
    );
    if (res.type !== "run") throw new OakEngineError({ message: "Protocol mismatch." }, true);
    if (!res.ok) throw new OakEngineError(res.error);
    return res.result;
  }

  /**
   * Run a compiled script as the study `runKey` of a chart (one per chart and study instance): the worker keeps its
   * run and bars, so a live update sends the changed bars only and the script calculates the newest bars when it
   * can. `fullRunReason`: why it calculates every bar instead (null: it does not). The reply may be the changes from
   * the previous result, applied to it in place (the caller does not change the results it gets). `restamp`: the
   * chart's daily and longer bars, put at the session open in the worker (the result comes back on the chart's
   * times).
   */
  async update(
    runKey: string,
    scriptId: string,
    bars: OakBar[],
    inputs?: Record<string, unknown>,
    chart?: ChartContext,
    symbols?: OakSymbolData,
    sources?: OakSourceData,
    restamp = false,
  ): Promise<{ result: unknown; fullRunReason: string | null }> {
    const key = `run:${runKey}`;
    for (let whole = false; ; whole = true) {
      const sent = this.live.request(key, bars, whole);
      const res = await this.request(
        { id: ++this.seq, type: "run", scriptId, bars: sent.bars, inputs, chart, symbols, live: sent.live, restamp, ...(sources ? { sources } : {}) },
        RUN_TIMEOUT_MS,
      );
      if (res.type !== "run") throw new OakEngineError({ message: "Protocol mismatch." }, true);
      if (!res.ok && "resend" in res && !whole) continue;
      if (!res.ok) {
        this.live.forget(key);
        throw new OakEngineError(res.error);
      }
      if (!res.live) return { result: res.result, fullRunReason: null };
      return { result: this.live.received(key, res.result, res.live), fullRunReason: res.live.fullRunReason };
    }
  }

  /** Backtest a compiled strategy script over `bars` on the OpenTrader broker.
   *  `properties` overrides the script's strategy() properties; `heikinAshi`:
   *  the chart shows Heikin Ashi bars of `bars`; `magnify`: the effective bar
   *  magnifier property (the lower-timeframe bars are fetched here). `live`: the run key of a strategy on a chart
   *  (see update()). */
  async backtest(
    scriptId: string,
    bars: OakBar[],
    inputs?: Record<string, unknown>,
    properties?: Partial<StrategyProperties>,
    chart?: ChartContext,
    heikinAshi?: boolean,
    magnify = properties?.barMagnifier === true,
    symbols?: OakSymbolData,
    live?: string,
  ): Promise<BacktestOutput> {
    const intrabars = await intrabarsRef(magnify, heikinAshi, bars, chart, this.sent);
    const key = live === undefined ? null : `backtest:${live}`;
    for (let whole = false; ; whole = true) {
      const sent = key === null ? null : this.live.request(key, bars, whole);
      const res = await this.request(
        { id: ++this.seq, type: "backtest", scriptId, bars: sent?.bars ?? bars, inputs, properties, chart, heikinAshi, intrabars, symbols, ...(sent ? { live: sent.live } : {}) },
        BACKTEST_TIMEOUT_MS,
        () => {
          if (intrabars?.bars) this.sent.set(intrabars.key, intrabars.version);
        },
      );
      if (res.type !== "backtest") throw new OakEngineError({ message: "Protocol mismatch." }, true);
      if (!res.ok && "resend" in res && !whole) continue;
      if (!res.ok) {
        if (key !== null) this.live.forget(key);
        throw new OakEngineError(res.error);
      }
      if (key === null || !res.live) return { report: res.report, visuals: res.visuals };
      return { report: res.report, visuals: this.live.received(key, res.visuals, res.live), fullRunReason: res.live.fullRunReason };
    }
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
