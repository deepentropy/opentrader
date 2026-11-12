/*
 * A study's plot held as numbers. A result gives one object per bar for each plot ({ time, value, color? }); kept
 * whole in the worker (the reply the next one is counted from) and in the window, those objects took about half of a
 * long history's memory (12/11/2026, .tmp/memory-proto). Packed, a point is its time and value in two Float64Arrays
 * and its other fields in a list each: the packed lists of lightweight-charts-indicators, whose live runs also hold
 * their outputs so in the study workers (setPackedSeries).
 *
 * A packed plot reads as an array of points (Array.isArray, length, index, the Array methods, iteration): each read
 * makes the point object, the readers that look at a few points (legend, values at a time, the drawn window) are not
 * changed. It also grows and is cut back in place (length, push, index set): a worker reply's changes are put in it as
 * in an array. Packed lists do not cross the worker boundary: a reply carries their columns (forPost, fromPost).
 */
// The helpers entry: the whole library is loaded when a study first needs it, not with this module.
import { isPackedSeries, packedColumns, packedFromColumns, packedSeries, type PackedColumns } from "lightweight-charts-indicators/helpers";

type Point = { time: number; value: number; [field: string]: unknown };

export const isPacked = (v: unknown): boolean => isPackedSeries(v);

/** Fewest points a plot is packed from: a short list is not worth it. */
const PACK_FROM = 256;

/** A list of points packed when it is a long one of `{ time: number, ... }` points; anything else as it is. */
export function packPoints<T>(list: T): T {
  if (!Array.isArray(list) || list.length < PACK_FROM || isPacked(list)) return list;
  for (const p of [list[0], list[list.length - 1]]) {
    if (p === null || typeof p !== "object" || Array.isArray(p) || typeof (p as Point).time !== "number") return list;
  }
  return packedSeries(list) as unknown as T;
}

/** `result` with its plots packed (a new object; the result's own lists are left as they are). */
export function packPlots<T>(result: T): T {
  const plots = (result as { plots?: Record<string, unknown> } | null)?.plots;
  if (!plots || typeof plots !== "object") return result;
  const out: Record<string, unknown> = {};
  let changed = false;
  for (const [id, list] of Object.entries(plots)) {
    out[id] = packPoints(list);
    changed ||= out[id] !== list;
  }
  return changed ? { ...result, plots: out } : result;
}

/**
 * The points of `list` with field `field` set from `fn(the point's field from)` where it gives a value: on a packed
 * plot a new packed plot sharing its time and value columns (no point object made), else a mapped array.
 */
export function withField<T extends object>(list: readonly T[], field: string, from: string, fn: (x: unknown) => unknown): T[] {
  const cols = packedColumns(list);
  if (!cols) {
    return list.map((p) => {
      const v = fn((p as Record<string, unknown>)[from]);
      return v === undefined ? p : { ...p, [field]: v };
    });
  }
  const source = cols.extra[from] ?? [];
  const own = cols.extra[field];
  const next: unknown[] = new Array(cols.n);
  for (let i = 0; i < cols.n; i++) {
    const v = fn(source[i]);
    next[i] = v !== undefined ? v : own?.[i];
  }
  return packedFromColumns<T>({ n: cols.n, time: cols.time, value: cols.value, extra: { ...cols.extra, [field]: next } });
}

const same = (a: unknown, b: unknown) => a === b || (typeof a === "number" && typeof b === "number" && Number.isNaN(a) && Number.isNaN(b));

/** Point k of two column sets has the same fields and values. */
function sameAt(a: PackedColumns, b: PackedColumns, k: number): boolean {
  if (!same(a.time[k], b.time[k]) || !same(a.value[k], b.value[k])) return false;
  for (const f of new Set([...Object.keys(a.extra), ...Object.keys(b.extra)])) if (!same(a.extra[f]?.[k], b.extra[f]?.[k])) return false;
  return true;
}

/**
 * How many first points of `next` equal those of `prev` (up to `n`), or null when `prev` is not packed. Compares
 * the columns (both packed) or each plain point with the columns: no point object is made (a worker compares every
 * update's result with the one it sent).
 */
export function packedPrefix(next: readonly unknown[], prev: unknown, n: number): number | null {
  const cols = packedColumns(prev);
  if (!cols) return null;
  const nc = packedColumns(next);
  let k = 0;
  if (nc) {
    while (k < n && sameAt(nc, cols, k)) k++;
    return k;
  }
  const extras = Object.entries(cols.extra);
  for (; k < n; k++) {
    const p = next[k] as Record<string, unknown> | null;
    if (p === null || typeof p !== "object" || Array.isArray(p)) break;
    if (!same(p.time, cols.time[k]) || !same(typeof p.value === "number" ? p.value : NaN, cols.value[k])) break;
    let fields = 0;
    let ok = true;
    for (const f in p) {
      if (f === "time" || f === "value" || p[f] === undefined) continue;
      fields++;
      if (!same(p[f], cols.extra[f]?.[k])) {
        ok = false;
        break;
      }
    }
    if (!ok) break;
    for (const [, list] of extras) if (list[k] !== undefined) fields--;
    if (fields !== 0) break;
  }
  return k;
}

/** True when no point of `list` has a finite value (read from the value column of a packed list). */
export function noValue(list: readonly unknown[]): boolean {
  const cols = packedColumns(list);
  if (cols) {
    for (let i = 0; i < cols.n; i++) if (Number.isFinite(cols.value[i])) return false;
    return true;
  }
  return !list.some((p) => {
    const v = (p as { value?: unknown } | null)?.value;
    return typeof v === "number" && Number.isFinite(v);
  });
}

/** The key of a packed list's columns in a message (a plain object: it crosses the worker boundary). */
const POSTED = "\u0000packed";

/** `v` with its packed lists (down to `depth` levels) as their columns, or as plain arrays when they hold other
 *  values than whole points: a message can carry it. */
export function forPost(v: unknown, depth = 4): unknown {
  if (v === null || typeof v !== "object") return v;
  if (isPacked(v)) {
    const cols = packedColumns(v);
    if (!cols) return [...(v as unknown[])];
    return { [POSTED]: { n: cols.n, time: cols.time.slice(0, cols.n), value: cols.value.slice(0, cols.n), extra: Object.fromEntries(Object.entries(cols.extra).map(([k, l]) => [k, l.slice(0, cols.n)])) } };
  }
  if (depth <= 0) return v;
  if (Array.isArray(v)) return v.some((x) => x !== null && typeof x === "object") ? v.map((x) => forPost(x, depth - 1)) : v;
  if (Object.getPrototypeOf(v) !== Object.prototype) return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) out[k] = forPost(x, depth - 1);
  return out;
}

/** A message's packed lists (forPost) back as packed lists, in place. */
export function fromPost(v: unknown, depth = 4): unknown {
  if (v === null || typeof v !== "object") return v;
  const posted = (v as Record<string, unknown>)[POSTED] as PackedColumns | undefined;
  if (posted) return packedFromColumns(posted);
  if (depth <= 0 || isPacked(v)) return v;
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) if (v[i] !== null && typeof v[i] === "object") v[i] = fromPost(v[i], depth - 1);
    return v;
  }
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) if (o[k] !== null && typeof o[k] === "object") o[k] = fromPost(o[k], depth - 1);
  return v;
}
