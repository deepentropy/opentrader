/*
 * The window's side of the study workers (study-calc.ts, in backtest workers): a small pool of their own, each job to
 * the least busy worker. A job
 * still running after JOB_TIMEOUT_MS ends its worker (the next job starts a new one) and fails, so a study that never
 * ends cannot hold the others.
 */
import StudyWorkerCtor from "../../../backtester/worker?worker";
import type { StudyJob, StudyReply } from "./study-worker-types";

const JOB_TIMEOUT_MS = 120_000;

type Slot = { worker: Worker; pending: Map<number, { resolve: (r: StudyReply) => void; timer: ReturnType<typeof setTimeout> }> };

/** One worker per four cores, two to four: a slow study does not delay the others. */
const POOL_SIZE = Math.min(4, Math.max(2, Math.floor((globalThis.navigator?.hardwareConcurrency ?? 8) / 4)));
const slots: (Slot | null)[] = Array.from({ length: POOL_SIZE }, () => null);
let seq = 0;

/** Studies can calculate off the window's thread here (not in tests, where there are no workers). */
export function studyWorkersAvailable(): boolean {
  return typeof Worker !== "undefined";
}

/** The worker ended: `culprit` (or every job, when none) fails, the other jobs are asked again. */
function failAll(slot: Slot, message: string, culprit?: number): void {
  for (const [id, p] of slot.pending) {
    clearTimeout(p.timer);
    p.resolve(culprit === undefined || id === culprit ? { id, error: message, missing: [], ms: 0 } : { id, retry: true, missing: [], ms: 0 });
  }
  slot.pending.clear();
}

function open(index: number): Slot {
  const worker = new StudyWorkerCtor();
  const slot: Slot = { worker, pending: new Map() };
  worker.onmessage = (e: MessageEvent<StudyReply>) => {
    const p = slot.pending.get(e.data.id);
    if (!p) return;
    slot.pending.delete(e.data.id);
    clearTimeout(p.timer);
    p.resolve(e.data);
  };
  worker.onerror = () => close(index, "The calculation stopped.");
  slots[index] = slot;
  return slot;
}

function close(index: number, message: string, culprit?: number): void {
  const slot = slots[index];
  if (!slot) return;
  slots[index] = null;
  slot.worker.terminate();
  failAll(slot, message, culprit);
}

/** Calculate a study in a worker: `slot`, the one its jobs went to (it keeps the study's last result), else the
 *  least busy one. Never rejects: a failure comes back as the reply's error. */
export function calculateInWorker(job: Omit<StudyJob, "id" | "kind">, slot?: number): Promise<{ reply: StudyReply; slot: number }> {
  let index = 0;
  if (slot !== undefined && slot < slots.length) index = slot;
  else for (let i = 1; i < slots.length; i++) if ((slots[i]?.pending.size ?? 0) < (slots[index]?.pending.size ?? 0)) index = i;
  const s = slots[index] ?? open(index);
  const id = ++seq;
  return new Promise((resolve) => {
    const timer = setTimeout(() => close(index, "The calculation took too long.", id), JOB_TIMEOUT_MS);
    s.pending.set(id, { resolve: (reply) => resolve({ reply, slot: index }), timer });
    s.worker.postMessage({ ...job, id, kind: "study" } satisfies StudyJob);
  });
}
