/*
 * A study's plot held as numbers. A result gives one object per bar for each plot ({ time, value, color? }); kept
 * whole in the worker (the reply the next one is counted from) and in the window, those objects took about half of a
 * long history's memory (12/11/2026, .tmp/memory-proto). Packed, a point is its time and value in two Float64Arrays
 * and its other fields in a list each (a colour given on each bar is the same string on every bar).
 *
 * A packed plot reads as an array of points (Array.isArray, length, index, the Array methods, iteration): each read
 * makes the point object, the readers that look at a few points (legend, values at a time, the drawn window) are not
 * changed. It also grows and is cut back in place (length, push, index set): a worker reply's changes are put in it as
 * in an array.
 */

type Point = { time: number; value: number; [field: string]: unknown };

const PACKED = Symbol("packed points");

class Columns {
  n = 0;
  time: Float64Array;
  value: Float64Array;
  /** The other fields of the points, by name (undefined where a point has none). */
  extra = new Map<string, unknown[]>();

  constructor(capacity: number) {
    this.time = new Float64Array(Math.max(16, capacity));
    this.value = new Float64Array(Math.max(16, capacity));
  }

  private grow(size: number): void {
    if (size <= this.time.length) return;
    const cap = Math.max(size, this.time.length + (this.time.length >> 1));
    const t = new Float64Array(cap);
    t.set(this.time.subarray(0, this.n));
    const v = new Float64Array(cap);
    v.set(this.value.subarray(0, this.n));
    this.time = t;
    this.value = v;
  }

  get(i: number): Point {
    const p: Point = { time: this.time[i], value: this.value[i] };
    for (const [k, list] of this.extra) {
      const x = list[i];
      if (x !== undefined) p[k] = x;
    }
    return p;
  }

  set(i: number, p: Partial<Point> | null | undefined): void {
    if (i >= this.n) {
      this.grow(i + 1);
      // A gap (an index set past the end): points without a value.
      for (let k = this.n; k < i; k++) {
        this.time[k] = NaN;
        this.value[k] = NaN;
      }
    }
    this.time[i] = (p?.time as number) ?? NaN;
    const v = p?.value;
    this.value[i] = typeof v === "number" ? v : NaN;
    for (const list of this.extra.values()) if (i < list.length) list[i] = undefined;
    if (p) {
      for (const k in p) {
        if (k === "time" || k === "value") continue;
        const x = p[k];
        if (x === undefined) continue;
        let list = this.extra.get(k);
        if (!list) this.extra.set(k, (list = []));
        list[i] = x;
      }
    }
    if (i >= this.n) this.n = i + 1;
  }

  setLength(len: number): void {
    if (len < this.n) {
      for (const list of this.extra.values()) if (list.length > len) list.length = len;
    } else if (len > this.n) {
      this.grow(len);
      for (let k = this.n; k < len; k++) {
        this.time[k] = NaN;
        this.value[k] = NaN;
      }
    }
    this.n = len;
  }
}

const isIndex = (p: string | symbol): p is string => typeof p === "string" && p !== "" && String(+p >>> 0) === p;

function view(cols: Columns): Point[] {
  return new Proxy([] as Point[], {
    get(target, prop, receiver) {
      if (prop === "length") return cols.n;
      if (prop === PACKED) return cols;
      if (isIndex(prop)) {
        const i = +prop;
        return i < cols.n ? cols.get(i) : undefined;
      }
      return Reflect.get(target, prop, receiver);
    },
    set(target, prop, value) {
      if (prop === "length") {
        cols.setLength(value as number);
        return true;
      }
      if (isIndex(prop)) {
        cols.set(+prop, value as Point);
        return true;
      }
      return Reflect.set(target, prop, value);
    },
    has(target, prop) {
      if (isIndex(prop)) return +prop < cols.n;
      return Reflect.has(target, prop);
    },
    getOwnPropertyDescriptor(target, prop) {
      if (prop === "length") return { value: cols.n, writable: true, enumerable: false, configurable: false };
      if (isIndex(prop)) return +prop < cols.n ? { value: cols.get(+prop), writable: true, enumerable: true, configurable: true } : undefined;
      return Reflect.getOwnPropertyDescriptor(target, prop);
    },
    ownKeys(target) {
      const keys: (string | symbol)[] = [];
      for (let i = 0; i < cols.n; i++) keys.push(String(i));
      for (const k of Reflect.ownKeys(target)) if (!isIndex(k)) keys.push(k);
      return keys;
    },
    deleteProperty(target, prop) {
      if (isIndex(prop)) {
        if (+prop < cols.n) cols.set(+prop, null);
        return true;
      }
      return Reflect.deleteProperty(target, prop);
    },
  });
}

/** The columns of a packed plot, null for any other value. */
function columnsOf(v: unknown): Columns | null {
  return v !== null && typeof v === "object" && Array.isArray(v) ? ((v as unknown as Record<symbol, Columns | undefined>)[PACKED] ?? null) : null;
}

export const isPacked = (v: unknown): boolean => columnsOf(v) !== null;

/** Fewest points a plot is packed from: a short list is not worth it. */
const PACK_FROM = 256;

/** A list of points packed when it is a long one of `{ time: number, ... }` points; anything else as it is. */
export function packPoints<T>(list: T): T {
  if (!Array.isArray(list) || list.length < PACK_FROM || isPacked(list)) return list;
  for (const p of [list[0], list[list.length - 1]]) {
    if (p === null || typeof p !== "object" || Array.isArray(p) || typeof (p as Point).time !== "number") return list;
  }
  const cols = new Columns(list.length);
  for (let i = 0; i < list.length; i++) cols.set(i, list[i] as Point);
  return view(cols) as T;
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
 * The points of `list` with field `field` set from `fn(point index, the point's own field values)` where it gives a
 * value: on a packed plot a new packed plot sharing its time and value columns (no point object made), else a mapped
 * array.
 */
export function withField<T extends object>(list: readonly T[], field: string, from: string, fn: (x: unknown) => unknown): T[] {
  const cols = columnsOf(list);
  if (!cols) {
    return list.map((p) => {
      const v = fn((p as Record<string, unknown>)[from]);
      return v === undefined ? p : { ...p, [field]: v };
    });
  }
  const out = new Columns(0);
  out.n = cols.n;
  out.time = cols.time;
  out.value = cols.value;
  for (const [k, l] of cols.extra) out.extra.set(k, l);
  const source = cols.extra.get(from) ?? [];
  const own = cols.extra.get(field);
  const next: unknown[] = new Array(cols.n);
  for (let i = 0; i < cols.n; i++) {
    const v = fn(source[i]);
    next[i] = v !== undefined ? v : own?.[i];
  }
  out.extra.set(field, next);
  return view(out) as unknown as T[];
}

const same = (a: unknown, b: unknown) => a === b || (typeof a === "number" && typeof b === "number" && Number.isNaN(a) && Number.isNaN(b));

/**
 * How many first points of `next` (plain points) equal those of `prev` (up to `n`), or null when `prev` is not packed.
 * Compares the columns: no point object is made (a worker compares every update's result with the one it sent).
 */
export function packedPrefix(next: readonly unknown[], prev: unknown, n: number): number | null {
  const cols = columnsOf(prev);
  if (!cols) return null;
  const extras = [...cols.extra];
  let k = 0;
  for (; k < n; k++) {
    const p = next[k] as Record<string, unknown> | null;
    if (p === null || typeof p !== "object" || Array.isArray(p)) break;
    if (!same(p.time, cols.time[k]) || !same(typeof p.value === "number" ? p.value : NaN, cols.value[k])) break;
    let fields = 0;
    let ok = true;
    for (const f in p) {
      if (f === "time" || f === "value") continue;
      if (p[f] === undefined) continue;
      fields++;
      if (!same(p[f], cols.extra.get(f)?.[k])) {
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
