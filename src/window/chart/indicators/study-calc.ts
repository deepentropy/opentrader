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
import type { IndicatorRegistryEntry } from "lightweight-charts-indicators";
import { ACCESSORS, callKey, deltaSnapshot, encodeDelta, type StudyCall, type StudyJob, type StudyReply } from "./study-worker-types";
import { restoreTimes, scriptBars } from "../../../backtester/oakscript";

/** A run of a library study (lightweight-charts-indicators `createRun`, on the ported studies): `update` gives the
 *  result of `calculate` on these bars, calculated from bar `from` (the newest bars on a live update). */
type IndicatorRun = { update(bars: Bar[], chart?: unknown): object & { from: number }; readonly fullRunReason: string | null };
type RunEntry = IndicatorRegistryEntry & { createRun?: (inputs?: Record<string, unknown>, chart?: unknown) => IndicatorRun };

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
};

/** The studies calculated the least recently are dropped past STATES_KEPT (a removed study sends no more jobs). */
const states = new Map<string, StudyState>();
const STATES_KEPT = 48;

/** The library, loaded with the first study job (a worker running backtests only does not load it). */
let registry: Promise<Map<string, RunEntry>> | null = null;

export function isStudyJob(m: unknown): m is StudyJob {
  return (m as { kind?: unknown } | null)?.kind === "study";
}

/** The study's state after the job: the whole of it (no `prev`), or the held one with the job's changes. Null: the
 *  worker does not hold the state the job changes (it ended, or dropped the study). */
function stateOf(job: StudyJob): StudyState | null {
  const held = states.get(job.study);
  states.delete(job.study);
  let st: StudyState;
  if (job.prev === null) {
    const data: Record<string, unknown> = {};
    for (const [k, c] of Object.entries(job.data)) if ("value" in c) data[k] = c.value;
    const seen = job.restamp ? scriptBars(job.bars, job.ctx) : job.bars;
    st = { id: job.id, bars: job.bars, seen, data, run: null, runInputs: "", sent: held?.sent ?? null };
  } else {
    if (!held || held.id !== job.prev) return null;
    st = held;
    st.id = job.id;
    // The new bars from barsFrom, restamped like the others.
    st.bars.length = job.barsFrom;
    for (const b of job.bars) st.bars.push(b);
    if (st.seen !== st.bars) {
      st.seen.length = job.barsFrom;
      for (const b of scriptBars(job.bars, job.ctx)) st.seen.push(b);
    }
    for (const [k, c] of Object.entries(job.data)) {
      if ("value" in c) st.data[k] = c.value;
      else {
        const list = st.data[k] as unknown[];
        list.length = c.from;
        for (const x of c.items) list.push(x);
      }
    }
  }
  states.set(job.study, st);
  if (states.size > STATES_KEPT) states.delete(states.keys().next().value as string);
  return st;
}

export async function calculateStudy(job: StudyJob): Promise<StudyReply> {
  registry ??= import("lightweight-charts-indicators").then((m) => new Map(m.indicatorRegistry.map((e) => [e.id, e as RunEntry])));
  const entry = (await registry).get(job.entryId);
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
        st.run = entry.createRun(job.inputs, ctx);
        st.runInputs = inputs;
      }
      const { from: first, ...out } = st.run.update(st.seen, ctx) as { from: number };
      from = first;
      result = out;
    } else {
      result = (entry.calculate as (b: Bar[], i: Record<string, unknown>, c: unknown) => unknown)(st.seen, job.inputs, ctx);
    }
    if (st.seen !== st.bars && result && typeof result === "object") restoreTimes(result, st.seen, st.bars);
    const prev = st.sent;
    const snapshot = deltaSnapshot(result, st.bars.length);
    st.sent = { id: job.id, result: snapshot };
    const ms = performance.now() - t0;
    if (prev && prev.id === job.base) {
      return { id: job.id, base: prev.id, result: encodeDelta(result, prev.result, 0, from > 0 ? { from, bars: st.bars.length } : undefined), missing, ms };
    }
    return { id: job.id, result, missing, ms };
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
