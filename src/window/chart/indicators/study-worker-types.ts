/* Messages between the window and the study workers (study-calc.ts). */
import type { Bar } from "oakscriptjs";
import { isPacked, noValue, packPoints, packedPrefix } from "./packed-points";

/** Accessors of the chart context a study may call (StudyCalcContext). */
export const ACCESSORS = ["bars", "symbolInfo", "lowerBars", "chartEvents", "fundamentals"] as const;
export type StudyAccessor = (typeof ACCESSORS)[number];

/** One accessor call of a calculation: the window reads it and sends its value with the next job. */
export type StudyCall = { kind: StudyAccessor; args: unknown[] };

/** A new accessor value, or the items of a bars value from index `from` (the ones before are unchanged). */
export type DataChange = { value: unknown } | { from: number; items: unknown[] };

/** Index of the first bar of `next` that differs from `prev` (all fields compared); the shorter length when one ends. */
export function firstChangedBar(prev: ArrayLike<Bar>, next: ArrayLike<Bar>): number {
  const n = Math.min(prev.length, next.length);
  for (let i = 0; i < n; i++) {
    const a = prev[i]!;
    const b = next[i]!;
    if (a === b) continue;
    if (!Object.is(a.time, b.time) || !Object.is(a.open, b.open) || !Object.is(a.high, b.high) || !Object.is(a.low, b.low) || !Object.is(a.close, b.close) || !Object.is(a.volume, b.volume)) return i;
  }
  return n;
}

/** A list of bars (the chart's, another symbol's): sent as its changed tail. */
export function isBarList(v: unknown): v is Bar[] {
  if (!Array.isArray(v) || v.length === 0) return false;
  const b = v[0] as Bar | null;
  return b !== null && typeof b === "object" && typeof b.time === "number" && typeof b.close === "number";
}

/** What the window sent a study's worker: the job whose state the worker holds, its bars and accessor values (bar
 *  lists copied, the other values as their signature). */
export type SentState = { stateId: number | null; bars: Bar[] | null; data: Map<string, unknown> };

/**
 * The part of a job that changed since the one `sent` describes (whole when the worker holds nothing), and `sent`
 * updated to this job: the bars from the first changed one, the accessor values that changed (bar lists as their
 * changed tail). `signature` tells whether a value that is not a bar list changed.
 */
export function jobChanges(
  sent: SentState,
  bars: Bar[],
  data: Record<string, unknown>,
  signature: (v: unknown) => string,
): { prev: number | null; barsFrom: number; bars: Bar[]; data: Record<string, DataChange> } {
  const whole = sent.stateId === null || sent.bars === null;
  if (whole) sent.data.clear();
  const barsFrom = whole ? 0 : firstChangedBar(sent.bars!, bars);
  const out: Record<string, DataChange> = {};
  for (const [k, v] of Object.entries(data)) {
    const before = sent.data.get(k);
    if (isBarList(v)) {
      const from = !whole && isBarList(before) ? firstChangedBar(before, v) : 0;
      if (from === 0) out[k] = { value: v.slice() };
      else if (from < v.length || v.length !== (before as Bar[]).length) out[k] = { from, items: v.slice(from) };
      sent.data.set(k, v.slice());
    } else {
      const sig = signature(v);
      if (whole || before !== sig) out[k] = { value: v };
      sent.data.set(k, sig);
    }
  }
  const prev = whole ? null : sent.stateId;
  // Copies: the chart's bars change in place on live updates.
  const changed = bars.slice(barsFrom);
  sent.bars = bars.slice();
  return { prev, barsFrom, bars: changed, data: out };
}

export function callKey(kind: StudyAccessor, args: unknown[]): string {
  return `${kind}:${JSON.stringify(args)}`;
}

export type StudyJob = {
  kind: "study";
  id: number;
  /** Registry id of the library entry. */
  entryId: string;
  /** The study on its chart (`chartId|studyId`): the worker keeps its last result. */
  study: string;
  /** Id of the job whose result the window holds for the study: the reply may be the changes from it. */
  base: number | null;
  /**
   * Id of the job whose bars and data the worker holds for the study (null: this job gives them whole). The job then
   * gives the changes only: `bars` replaces the bars from `barsFrom` (a live update: the forming bar and the new
   * ones), `data` the accessor values that changed. A worker that does not hold that job's state asks again (retry).
   */
  prev: number | null;
  /** The chart's bars from index `barsFrom`; `restamp`: daily and longer bars at the session open as studies read
   *  them, the result put back on the chart's times. */
  bars: Bar[];
  barsFrom: number;
  restamp: boolean;
  inputs: Record<string, unknown>;
  /** The chart context without its functions. */
  ctx: Record<string, unknown>;
  /** Accessors the window's context has (a chart without other symbols has none). */
  accessors: StudyAccessor[];
  /** Accessor values (by callKey) that changed since `prev`: the others stay as the worker holds them. */
  data: Record<string, DataChange>;
  /** Values of the other sources the inputs name (study on study), by input value. */
  sources: Record<string, ArrayLike<number>>;
};

export type StudyReply = {
  id: number;
  result?: unknown;
  /** `result` holds the changes from the result of job `base` (encodeDelta). */
  base?: number;
  /** The data it reads is not there yet (other symbols loading). */
  pending?: boolean;
  error?: string;
  /** Status title of the error (a study without the data it reads). */
  errorTitle?: string;
  /** The job was not calculated (its worker ended on another job's account): ask again. */
  retry?: boolean;
  /** Accessor calls the job had no data for. */
  missing: StudyCall[];
  /** Calculation time. */
  ms: number;
};

/*
 * A live update changes the newest points of a result: the worker sends the arrays of the result as the points that
 * changed after the prefix they share with the study's previous result, the window puts them back together with its
 * copy (a heavy study's result is megabytes: copying it whole on every update held the window's thread).
 */
const TAIL = "\u0000tail";
type Tail = { [TAIL]: number; items: unknown[] };

function isPlain(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") return Number.isNaN(a) && Number.isNaN(b);
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Two points of a result: the same fields with the same values. */
function samePoint(a: unknown, b: unknown): boolean {
  // The same object: a resumed run gives its unchanged points again (a run that changes points in place is sent
  // from its first recalculated bar instead, see encodeDelta's bound).
  if (a === b) return true;
  if (!isPlain(a) || !isPlain(b)) return sameValue(a, b);
  let n = 0;
  for (const k in a) {
    if (!sameValue(a[k], b[k])) return false;
    n++;
  }
  for (const _ in b) n--;
  return n === 0;
}

/**
 * `next` as the changes from `prev` (arrays as their tail after the shared prefix), down to `depth` levels. `bound`: a
 * resumed run recalculated the bars from `bound.from` (its arrays of one point per bar, `bound.bars` long, may hold
 * the same point objects changed in place): those arrays are sent from that bar at the latest.
 */
export function encodeDelta(next: unknown, prev: unknown, depth = 0, bound?: { from: number; bars: number }): unknown {
  if (Array.isArray(next) && Array.isArray(prev)) {
    const n = Math.min(next.length, prev.length, bound && next.length === bound.bars ? bound.from : Infinity);
    let k = packedPrefix(next, prev, n) ?? 0;
    if (!isPacked(prev)) while (k < n && samePoint(next[k], prev[k])) k++;
    // A short shared prefix is not worth it.
    return k < 32 ? next : ({ [TAIL]: k, items: next.slice(k) } satisfies Tail);
  }
  if (depth < 3 && isPlain(next) && isPlain(prev)) {
    const out: Record<string, unknown> = {};
    for (const k in next) out[k] = encodeDelta(next[k], prev[k], depth + 1, bound);
    return out;
  }
  return next;
}

/**
 * What a later encodeDelta compares with: the result's objects and arrays copied down to the levels encodeDelta reads
 * (a resumed run may change its arrays in place), with the points of the arrays shorter than a bar list copied too
 * (markers, labels: a run may change one in place); the points of the per-bar arrays are bounded by `from` instead.
 */
export function deltaSnapshot(result: unknown, bars: number, depth = 0): unknown {
  // A list of one point per bar packed (packed-points.ts): the worker keeps it until the next update.
  if (Array.isArray(result)) return result.length === bars ? packPoints(result.slice()) : result.map((p) => (isPlain(p) ? { ...p } : p));
  if (depth < 3 && isPlain(result)) {
    const out: Record<string, unknown> = {};
    for (const k in result) out[k] = deltaSnapshot(result[k], bars, depth + 1);
    return out;
  }
  return result;
}

/**
 * `result` with its plots that have no value on any bar (a switched-off option: an RSI's bands, an SMA's smoothing)
 * as empty lists: they held one point per bar in the worker and in the window, more than half of a study's result
 * (12/11/2026, .tmp/memory-proto). The readers take a missing point as no value. A new object when one changed.
 */
export function withoutEmptyPlots<T>(result: T): T {
  const plots = (result as { plots?: Record<string, unknown[]> } | null)?.plots;
  if (!plots || typeof plots !== "object") return result;
  let out: Record<string, unknown[]> | null = null;
  for (const [id, points] of Object.entries(plots)) {
    if (!Array.isArray(points) || points.length === 0 || !noValue(points)) continue;
    out ??= { ...plots };
    out[id] = [];
  }
  return out ? { ...result, plots: out } : result;
}

/** One string per text: a reply comes through the worker boundary with its own copy of every string, so a colour
 *  given on each bar (a gradient, a coloured volume) was held as many times as there are bars. */
const strings = new Map<string, string>();
const STRINGS_KEPT = 10_000;
function one(s: string): string {
  if (s.length > 64) return s;
  const kept = strings.get(s);
  if (kept !== undefined) return kept;
  if (strings.size >= STRINGS_KEPT) strings.clear();
  strings.set(s, s);
  return s;
}

/** The short strings of `v` (arrays of strings, fields of plain objects and of their arrays' points, `depth` levels
 *  down) replaced by one copy each, in place. */
export function shareStrings(v: unknown, depth = 4): void {
  if (depth < 0 || v === null || typeof v !== "object") return;
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      const x = v[i];
      if (typeof x === "string") v[i] = one(x);
      else if (x !== null && typeof x === "object") shareStrings(x, depth - 1);
    }
    return;
  }
  if (!isPlain(v)) return;
  for (const k in v) {
    const x = v[k];
    if (typeof x === "string") v[k] = one(x);
    else if (x !== null && typeof x === "object") shareStrings(x, depth - 1);
  }
}

/** The result `delta` (encodeDelta) describes from `prev`. Its arrays are those of `prev`, changed in place (a copy
 *  of every array of a heavy study cost tens of milliseconds per update): `prev` is not read again. */
export function applyDelta(delta: unknown, prev: unknown, changed = new Set<unknown[]>()): unknown {
  if (isPlain(delta) && TAIL in delta) {
    const t = delta as unknown as Tail;
    const list = prev as unknown[];
    // An array the result holds twice (two plots of the same points) changes once.
    if (changed.has(list)) return list;
    changed.add(list);
    list.length = t[TAIL];
    for (const item of t.items) list.push(item);
    return list;
  }
  if (isPlain(delta) && isPlain(prev)) {
    const out: Record<string, unknown> = {};
    for (const k in delta) out[k] = applyDelta(delta[k], prev[k], changed);
    return out;
  }
  return delta;
}
