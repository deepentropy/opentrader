/*
 * Calculates the indicator library's studies off the window's thread (a heavy study held it for seconds on every
 * live update, issue #249). It runs in the backtest worker (backtester/worker.ts), which carries the library already:
 * a worker of its own would bundle the library a second time.
 *
 * The worker keeps the state of each study (#255): its bars, the data its accessors read (other symbols, lower
 * timeframe bars, chart events, fundamentals) and, for a study with a run (`createRun` of the library entry), the run
 * itself. A live update brings the changed bars only and the run calculates the newest bars only; the reply holds the
 * points that changed. An accessor call the job has no data for is reported back as missing (the window reads it and
 * sends it with the next job), as a load in progress.
 */
import { setSourceResolver, type Bar } from "oakscriptjs";
import { MissingSymbolDataError } from "oakscriptjs/script";
import type { LoadedIndicator } from "lightweight-charts-indicators/loader";
import { ACCESSORS, callKey, deltaSnapshot, encodeDelta, isBarList, withoutEmptyPlots, type StudyCall, type StudyJob, type StudyReply } from "./study-worker-types";
import { forPost } from "./packed-points";
import { restoreTimes, scriptBars } from "../../../backtester/oakscript";

/** A run of a library study (lightweight-charts-indicators `createRun`, on the ported studies): `update` gives the
 *  result of `calculate` on these bars, calculated from bar `from` (the newest bars on a live update). */
type IndicatorRun = { update(bars: Bar[], chart?: unknown): object & { from: number }; readonly fullRunReason: string | null };
type RunEntry = Omit<LoadedIndicator, "createRun"> & { createRun?: (inputs?: Record<string, unknown>, chart?: unknown) => IndicatorRun };

/** What the worker holds for a study between its jobs. */
type StudyState = {
  /** Job these bars and data are from (the window's next job names it in `prev`). */
  id: number;
  bars: Bar[];
  /** The bars as the study reads them (restamped daily bars), `bars` itself when not restamped. */
  seen: Bar[];
  data: Record<string, unknown>;
  run: IndicatorRun | null;
  /** Inputs the run was made with. */
  runInputs: string;
  /** Last result sent (deltaSnapshot) and its job: the next reply is the changes from it. */
  sent: { id: number; result: unknown } | null;
  /** The bar pools its bars and bar lists are from. */
  pools: Set<string>;
};

/** The studies calculated the least recently are dropped past STATES_KEPT (a removed study sends no more jobs). */
const states = new Map<string, StudyState>();
const STATES_KEPT = 48;

/**
 * The bar objects the states hold, one set per series (a chart's bars, a bar list an accessor read): every job brings
 * its own copies (a message is a copy), so each study on a chart held the chart's bars once more. A bar equal to the
 * one held at its index is replaced by it; the studies' runs keep their own copy of the values they compare.
 */
const barPools = new Map<string, Bar[]>();

/** Bars with the same fields and values (a study reads the bar it was sent). */
function sameBar(a: Bar, b: Bar): boolean {
  if (!Object.is(a.time, b.time) || !Object.is(a.close, b.close)) return false;
  const x = a as unknown as Record<string, unknown>;
  const y = b as unknown as Record<string, unknown>;
  for (const k in x) if (!Object.is(x[k], y[k])) return false;
  for (const k in y) if (!(k in x)) return false;
  return true;
}

/** `bars` (the series' bars from index `from`) with the held bar objects where they are equal; the held ones are then
 *  these bars, up to their end. */
function shareBars(pool: string, bars: Bar[], from: number): Bar[] {
  let held = barPools.get(pool);
  if (!held) barPools.set(pool, (held = []));
  if (held.length < from) held.length = from;
  for (let k = 0; k < bars.length; k++) {
    const h = held[from + k];
    if (h !== undefined && sameBar(h, bars[k]!)) bars[k] = h;
    else held[from + k] = bars[k]!;
  }
  held.length = from + bars.length;
  return bars;
}

/** The series of the chart's bars a job brings. */
const chartPool = (job: StudyJob) => `chart|${job.ctx.tickerid}|${job.ctx.timeframe}|${job.ctx.sessionType}`;

/** Drop the held bars no state reads any more (studies removed, a symbol changed). */
function dropUnusedPools(): void {
  const used = new Set<string>();
  for (const st of states.values()) for (const p of st.pools) used.add(p);
  for (const p of barPools.keys()) if (!used.has(p)) barPools.delete(p);
}

/** The library's loader (lightweight-charts-indicators/loader), loaded with the first study job (a worker running
 *  backtests only does not load it): it loads the code of the studies the worker calculates, not the whole library
 *  (~20 MB of script, held in every worker). */
let loader: Promise<typeof import("lightweight-charts-indicators/loader")> | null = null;
/** The library's packed mode switch (set with the loader: its runs read the loader's own). */
let setPackedSeries: (on: boolean) => void = () => {};

export function isStudyJob(m: unknown): m is StudyJob {
  return (m as { kind?: unknown } | null)?.kind === "study";
}

/** The study's state after the job: the whole of it (no `prev`), or the held one with the job's changes. Null: the
 *  worker does not hold the state the job changes (it ended, or dropped the study). */
function stateOf(job: StudyJob): StudyState | null {
  const held = states.get(job.study);
  states.delete(job.study);
  let st: StudyState;
  const pool = chartPool(job);
  if (job.prev === null) {
    const pools = new Set([pool]);
    const data: Record<string, unknown> = {};
    for (const [k, c] of Object.entries(job.data)) {
      if (!("value" in c)) continue;
      if (isBarList(c.value)) pools.add(`data|${k}`);
      data[k] = isBarList(c.value) ? shareBars(`data|${k}`, c.value, 0) : c.value;
    }
    const bars = shareBars(pool, job.bars, 0);
    const seen = job.restamp ? scriptBars(bars, job.ctx) : bars;
    st = { id: job.id, bars, seen, data, run: null, runInputs: "", sent: held?.sent ?? null, pools };
  } else {
    if (!held || held.id !== job.prev) return null;
    st = held;
    st.id = job.id;
    // The new bars from barsFrom, restamped like the others.
    const bars = shareBars(pool, job.bars, job.barsFrom);
    st.bars.length = job.barsFrom;
    for (const b of bars) st.bars.push(b);
    if (st.seen !== st.bars) {
      st.seen.length = job.barsFrom;
      for (const b of scriptBars(bars, job.ctx)) st.seen.push(b);
    }
    for (const [k, c] of Object.entries(job.data)) {
      if ("value" in c) {
        if (isBarList(c.value)) st.pools.add(`data|${k}`);
        st.data[k] = isBarList(c.value) ? shareBars(`data|${k}`, c.value, 0) : c.value;
      } else {
        const list = st.data[k] as Bar[];
        list.length = c.from;
        for (const x of shareBars(`data|${k}`, c.items as Bar[], c.from)) list.push(x);
      }
    }
  }
  states.set(job.study, st);
  if (states.size > STATES_KEPT) states.delete(states.keys().next().value as string);
  // A state made again (other bars, a symbol changed) or dropped may leave a pool no state reads.
  if (job.prev === null || states.size === STATES_KEPT) dropUnusedPools();
  return st;
}

export async function calculateStudy(job: StudyJob): Promise<StudyReply> {
  loader ??= import("lightweight-charts-indicators/loader").then((m) => {
    setPackedSeries = m.setPackedSeries;
    return m;
  });
  const entry = (await (await loader).loadIndicator(job.entryId)) as RunEntry | null;
  const missing: StudyCall[] = [];
  if (!entry) return { id: job.id, error: `Unknown study ${job.entryId}`, missing, ms: 0 };
  const st = stateOf(job);
  if (!st) return { id: job.id, retry: true, missing, ms: 0 };
  const ctx: Record<string, unknown> = { ...job.ctx };
  for (const kind of ACCESSORS) {
    if (!job.accessors.includes(kind)) continue;
    ctx[kind] = (...args: unknown[]) => {
      const key = callKey(kind, args);
      if (key in st.data) return st.data[key];
      if (!missing.some((m) => callKey(m.kind, m.args) === key)) missing.push({ kind, args });
      return undefined;
    };
  }
  setSourceResolver((name) => job.sources[name] ?? null);
  const t0 = performance.now();
  try {
    // One run per study and inputs: it calculates the newest bars only when the bars before them did not change.
    let from = 0;
    let result: unknown;
    if (entry.createRun) {
      const inputs = JSON.stringify(job.inputs);
      if (!st.run || st.runInputs !== inputs) {
        // The run holds its per-bar outputs as numbers (lightweight-charts-indicators packed mode): kept here between
        // updates, as objects they were most of a long history's memory in the workers.
        setPackedSeries(true);
        try {
          st.run = entry.createRun(job.inputs, ctx);
        } finally {
          setPackedSeries(false);
        }
        st.runInputs = inputs;
      }
      const { from: first, ...out } = st.run.update(st.seen, ctx) as { from: number };
      from = first;
      result = out;
    } else {
      result = (entry.calculate as (b: Bar[], i: Record<string, unknown>, c: unknown) => unknown)(st.seen, job.inputs, ctx);
    }
    if (st.seen !== st.bars && result && typeof result === "object") restoreTimes(result, st.seen, st.bars);
    // Before the snapshot, so the next reply's changes are counted from what this one sent.
    result = withoutEmptyPlots(result);
    const prev = st.sent;
    const snapshot = deltaSnapshot(result, st.bars.length);
    st.sent = { id: job.id, result: snapshot };
    const ms = performance.now() - t0;
    if (prev && prev.id === job.base) {
      return { id: job.id, base: prev.id, result: forPost(encodeDelta(result, prev.result, 0, from > 0 ? { from, bars: st.bars.length } : undefined)), missing, ms };
    }
    return { id: job.id, result: forPost(result), missing, ms };
  } catch (err) {
    // A run that stopped halfway is not resumed: the next job makes a new one.
    st.run = null;
    if (err instanceof MissingSymbolDataError) return { id: job.id, pending: true, missing, ms: performance.now() - t0 };
    // A study without the data it reads gives its own status title (studyErrorOf).
    const title = (err as { studyTitle?: unknown } | null)?.studyTitle;
    const message = err instanceof Error ? err.message : String(err);
    return { id: job.id, error: message, errorTitle: typeof title === "string" ? title : undefined, missing, ms: performance.now() - t0 };
  } finally {
    setSourceResolver(null);
  }
}
