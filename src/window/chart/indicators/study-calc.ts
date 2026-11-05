/*
 * Calculates the indicator library's studies off the window's thread (a heavy study held it for seconds on every
 * live update, issue #249). It runs in the backtest worker (backtester/worker.ts), which carries the library already:
 * a worker of its own would bundle the library a second time. Each job carries the bars, the inputs, the plain chart
 * context, the values of the sources its inputs name (study on study) and the data its accessors read (other
 * symbols, lower-timeframe bars, chart events, fundamentals). An accessor call the job has no data for is reported
 * back as missing (the window reads it and sends it with the next job), as a load in progress.
 */
import { setSourceResolver, type Bar } from "oakscriptjs";
import { MissingSymbolDataError } from "oakscriptjs/script";
import type { IndicatorRegistryEntry } from "lightweight-charts-indicators";
import { ACCESSORS, callKey, encodeDelta, type StudyCall, type StudyJob, type StudyReply } from "./study-worker-types";
import { restoreTimes, scriptBars } from "../../../backtester/oakscript";

/** Last result sent for each study (`study` of the jobs) and its job id: the next one goes as the changes from it.
 *  The studies calculated the least recently are dropped past SENT_KEPT (a removed study sends no more jobs). */
const sent = new Map<string, { id: number; result: unknown }>();
const SENT_KEPT = 48;

/** The library, loaded with the first study job (a worker running backtests only does not load it). */
let registry: Promise<Map<string, IndicatorRegistryEntry>> | null = null;

export function isStudyJob(m: unknown): m is StudyJob {
  return (m as { kind?: unknown } | null)?.kind === "study";
}

export async function calculateStudy(job: StudyJob): Promise<StudyReply> {
  registry ??= import("lightweight-charts-indicators").then((m) => new Map(m.indicatorRegistry.map((e) => [e.id, e])));
  const entry = (await registry).get(job.entryId);
  const missing: StudyCall[] = [];
  if (!entry) return { id: job.id, error: `Unknown study ${job.entryId}`, missing, ms: 0 };
  const ctx: Record<string, unknown> = { ...job.ctx };
  for (const kind of ACCESSORS) {
    if (!job.accessors.includes(kind)) continue;
    ctx[kind] = (...args: unknown[]) => {
      const key = callKey(kind, args);
      if (key in job.data) return job.data[key];
      if (!missing.some((m) => callKey(m.kind, m.args) === key)) missing.push({ kind, args });
      return undefined;
    };
  }
  setSourceResolver((name) => job.sources[name] ?? null);
  const t0 = performance.now();
  try {
    const seen = job.restamp ? scriptBars(job.bars, job.ctx) : job.bars;
    const result = (entry.calculate as (b: Bar[], i: Record<string, unknown>, c: unknown) => unknown)(seen, job.inputs, ctx);
    if (seen !== job.bars && result && typeof result === "object") restoreTimes(result, seen, job.bars);
    const prev = sent.get(job.study);
    sent.delete(job.study);
    sent.set(job.study, { id: job.id, result });
    if (sent.size > SENT_KEPT) sent.delete(sent.keys().next().value as string);
    if (prev && prev.id === job.base) return { id: job.id, base: prev.id, result: encodeDelta(result, prev.result), missing, ms: performance.now() - t0 };
    return { id: job.id, result, missing, ms: performance.now() - t0 };
  } catch (err) {
    if (err instanceof MissingSymbolDataError) return { id: job.id, pending: true, missing, ms: performance.now() - t0 };
    // A study without the data it reads gives its own status title (studyErrorOf).
    const title = (err as { studyTitle?: unknown } | null)?.studyTitle;
    const message = err instanceof Error ? err.message : String(err);
    return { id: job.id, error: message, errorTitle: typeof title === "string" ? title : undefined, missing, ms: performance.now() - t0 };
  } finally {
    setSourceResolver(null);
  }
}
