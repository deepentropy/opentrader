/*
 * Live runs of a chart's script in a worker (#255). The worker keeps, per run key (a study instance on a chart), the
 * bars it last calculated and the run of the script on them; a live update sends only the bars from the first one
 * that changed (the forming bar, and the new bars after it), the worker applies them to its bars and calculates the
 * newest bars only when the script allows it. The reply holds the changes from the result the host already has.
 *
 * Host side: `SentRuns` (what was sent for each key). Worker side: `KeptRuns` (the bars and runs kept).
 */
import { applyDelta, encodeDelta } from '../window/chart/indicators/study-worker-types';
import { createStrategyRun, type OakScriptRunOptions, type OakScriptStrategyRun } from './oakscript';
import type { BacktestReport, Bar } from './types';

/** A request of a live run: its `bars` are the bars from `from` (0: all of them). */
export interface LiveRequest {
  key: string;
  from: number;
  /** Id of the result the host has (null: none): the reply gives the changes from it. */
  base: number | null;
}

/** The live part of a reply. */
export interface LiveReply {
  /** Id of this result, the base of the next request. */
  id: number;
  /** The result is the changes from the base result (encodeDelta). */
  delta: boolean;
  /** Why the run calculates every bar on each update (null: it calculates the newest bars only). */
  fullRunReason: string | null;
}

/** Runs kept per key: a closed chart's runs go after the newest ones (the worker has no "closed" message). */
const KEPT_RUNS = 64;

const sameBar = (a: Bar, b: Bar): boolean =>
  a === b ||
  (a.time === b.time && a.open === b.open && a.high === b.high && a.low === b.low && a.close === b.close && (a.volume === b.volume || (a.volume !== a.volume && b.volume !== b.volume)));

/** Index of the first bar of `next` that differs from `sent` (the length of the shorter one when none does). */
export function changedFrom(sent: readonly Bar[] | undefined, next: readonly Bar[]): number {
  if (!sent) return 0;
  const n = Math.min(sent.length, next.length);
  let i = 0;
  while (i < n && sameBar(sent[i], next[i])) i++;
  return i;
}

/** A map that drops its least recently used entries beyond `cap`. */
class Recent<T> {
  private readonly map = new Map<string, T>();
  constructor(private readonly cap: number) {}

  get(key: string): T | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }

  set(key: string, v: T): void {
    this.map.delete(key);
    this.map.set(key, v);
    while (this.map.size > this.cap) this.map.delete(this.map.keys().next().value!);
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  deleteWhere(test: (key: string) => boolean): void {
    for (const k of [...this.map.keys()]) if (test(k)) this.map.delete(k);
  }

  clear(): void {
    this.map.clear();
  }
}

/** Host side: the bars sent for each run key and the result received for them. */
export class SentRuns {
  private readonly sent = new Recent<{ bars: readonly Bar[]; resultId: number | null; result: unknown }>(KEPT_RUNS);

  /** The request for `bars` (the caller's own array, not changed afterwards): the bars to post and the live part.
   *  `whole`: send all the bars (the worker no longer has the ones sent before). `delta`: the reply may give the
   *  changes from the result received before (false: the caller changes that result in place). */
  request<B extends Bar>(key: string, bars: B[], whole = false, delta = true): { bars: B[]; live: LiveRequest } {
    const prev = whole ? undefined : this.sent.get(key);
    const from = changedFrom(prev?.bars, bars);
    const base = delta ? (prev?.resultId ?? null) : null;
    // Recorded now: a later request of this key (posted before this reply) counts on these bars in the worker.
    this.sent.set(key, { bars, resultId: base, result: base === null ? undefined : prev?.result });
    return { bars: from ? bars.slice(from) : bars, live: { key, from, base } };
  }

  /** The result of a reply (the changes applied to the result kept for the key). */
  received(key: string, result: unknown, live: LiveReply): unknown {
    const s = this.sent.get(key);
    const full = live.delta && s ? applyDelta(result, s.result) : result;
    if (s) {
      s.resultId = live.id;
      s.result = full;
    }
    return full;
  }

  /** The run failed: the worker dropped it. */
  forget(key: string): void {
    this.sent.delete(key);
  }

  /** The worker was replaced. */
  clear(): void {
    this.sent.clear();
  }
}

/** Worker side: a kept run of a key, with the bars it calculated and the result last sent. */
export interface Kept<R> {
  bars: Bar[];
  run: R;
  resultId: number;
  result: unknown;
}

let resultSeq = 0;

/** Worker side: the runs kept per key. */
export class KeptRuns<R> {
  private readonly kept = new Recent<Kept<R>>(KEPT_RUNS);

  /**
   * The bars of a request: the changed bars applied to the kept ones. Null when the worker does not have the bars
   * the request counts on (a new worker, or a run dropped): the host sends them all again.
   */
  bars(live: LiveRequest, bars: Bar[]): { kept: Kept<R> | undefined; bars: Bar[] } | null {
    const kept = this.kept.get(live.key);
    if (live.from === 0) return { kept, bars };
    if (!kept || live.from > kept.bars.length) return null;
    const all = kept.bars.slice(0, live.from);
    for (const b of bars) all.push(b);
    return { kept, bars: all };
  }

  /** Keeps `run` on `bars` with its `result`: the reply (the changes from the host's result when it has the base). */
  keep(live: LiveRequest, kept: Kept<R> | undefined, bars: Bar[], run: R, result: unknown, fullRunReason: string | null): { result: unknown; live: LiveReply } {
    const delta = kept !== undefined && live.base !== null && live.base === kept.resultId;
    const id = ++resultSeq;
    this.kept.set(live.key, { bars, run, resultId: id, result });
    return { result: delta ? encodeDelta(result, kept.result) : result, live: { id, delta, fullRunReason } };
  }

  /** The run failed: what it changed in place cannot be used again. */
  drop(key: string): void {
    this.kept.delete(key);
  }

  /** Drops the runs whose key passes `test` (a recompiled script). */
  dropWhere(test: (key: string) => boolean): void {
    this.kept.deleteWhere(test);
  }
}

/** A kept strategy run and the script body it runs (a recompiled script is another body). */
export type KeptStrategy = { body: () => void; run: OakScriptStrategyRun };

/**
 * Worker side of a live strategy: its run on the request's bars, the report, and the drawn outputs as the changes
 * from the host's. Null: the worker does not have the bars the request counts on (the host sends them all again).
 */
export function updateLiveStrategy(
  kept: KeptRuns<KeptStrategy | null>,
  live: LiveRequest,
  body: () => void,
  bars: Bar[],
  opts: OakScriptRunOptions,
): { report?: BacktestReport; visuals: unknown; live: LiveReply } | null {
  const got = kept.bars(live, bars);
  if (!got) return null;
  const prev = got.kept?.run;
  const strategy = prev && prev.body === body ? prev : { body, run: createStrategyRun(body) };
  let out: ReturnType<OakScriptStrategyRun['update']>;
  try {
    out = strategy.run.update(got.bars, opts);
  } catch (err) {
    kept.drop(live.key);
    throw err;
  }
  const visuals = out.script.drawingKinds.length ? { ...out.script.result, drawingKinds: out.script.drawingKinds } : out.script.result;
  const reply = kept.keep(live, got.kept, got.bars, strategy, visuals, out.fullRunReason);
  return { report: out.report, visuals: reply.result, live: reply.live };
}
