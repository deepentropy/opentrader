/*
 * Price-based chart transforms driven by the Symbol-tab style inputs
 * (Renko / Kagi / Point & figure / Line break / Range).
 *
 * Construction rules (Renko, Kagi, Line break, Point & figure, Range, hollow
 * candles):
 *   • box size: ATR (the ATR(length) value a regular candle chart would show,
 *     i.e. Wilder's RMA of the true range at the last loaded bar),
 *     Traditional (fixed value) or Percentage LTP (percent of the last close,
 *     rounded to the minimum tick);
 *   • Renko bricks touch at the corners and never share a column (a reversal
 *     needs two boxes);
 *   • projection bars / lines / columns = the ones built from the bar that is
 *     still forming (real-time only).
 * Items carry a synthetic, strictly ascending time: price-based charts have
 * no time axis of their own.
 */
import type { Time, UTCTimestamp } from "lightweight-charts";
import type { OHLC } from "lightweight-charts-drawing/tv/coords";
import type { BoxInputs, PriceSource } from "../header/chart-settings";

// ── Common helpers ──────────────────────────────────────────────────────────

export function toSeconds(t: Time): number {
  if (typeof t === "number") return t;
  if (typeof t === "string") return Math.floor(new Date(t).getTime() / 1000);
  return Math.floor(new Date(`${t.year}-${String(t.month).padStart(2, "0")}-${String(t.day).padStart(2, "0")}`).getTime() / 1000);
}

/** Give price-based items strictly ascending synthetic times, spaced by the
 *  source's median bar interval (min 60 s) and ENDING at the last source bar,
 *  so the newest brick sits where the realtime view looks. */
export function assignTimes<T extends { time: Time }>(items: T[], raw: OHLC[]): T[] {
  if (raw.length === 0) return items;
  const ds: number[] = [];
  for (let i = Math.max(1, raw.length - 60); i < raw.length; i++) ds.push(toSeconds(raw[i].time) - toSeconds(raw[i - 1].time));
  ds.sort((a, b) => a - b);
  const step = Math.max(60, ds.length ? ds[Math.floor(ds.length / 2)] : 60);
  const end = toSeconds(raw[raw.length - 1].time);
  const n = items.length;
  for (let i = 0; i < n; i++) items[i].time = (end - (n - 1 - i) * step) as UTCTimestamp;
  return items;
}

/** Price-source value of a bar. */
export function priceOf(r: OHLC, src: PriceSource): number {
  switch (src) {
    case "open": return r.open;
    case "high": return r.high;
    case "low": return r.low;
    case "hl2": return (r.high + r.low) / 2;
    case "hlc3": return (r.high + r.low + r.close) / 3;
    case "ohlc4": return (r.open + r.high + r.low + r.close) / 4;
    default: return r.close;
  }
}

/** Minimum tick of a US equity price (0.01 at or above $1, 0.0001 below). */
export function minTickFor(price: number): number {
  return Math.abs(price) >= 1 ? 0.01 : 0.0001;
}

/** ATR(length) at the last bar — Wilder's RMA of the true range (Pine `ta.atr`). */
export function atrAtLast(raw: OHLC[], length: number): number {
  const n = Math.max(1, Math.round(length));
  if (raw.length === 0) return 0;
  const tr = (i: number) =>
    i === 0
      ? raw[0].high - raw[0].low
      : Math.max(raw[i].high - raw[i].low, Math.abs(raw[i].high - raw[i - 1].close), Math.abs(raw[i].low - raw[i - 1].close));
  if (raw.length < n) {
    let s = 0;
    for (let i = 0; i < raw.length; i++) s += tr(i);
    return s / raw.length;
  }
  let atr = 0;
  for (let i = 0; i < n; i++) atr += tr(i);
  atr /= n;
  for (let i = n; i < raw.length; i++) atr = (atr * (n - 1) + tr(i)) / n;
  return atr;
}

/** Box size from the "Box size assignment method" inputs. */
export function boxSize(raw: OHLC[], box: BoxInputs): number {
  if (raw.length === 0) return 0;
  const last = raw[raw.length - 1].close;
  const tick = minTickFor(last);
  let v: number;
  if (box.method === "Traditional") v = box.size;
  else if (box.method === "Percentage LTP") v = Math.round(((box.percentage / 100) * last) / tick) * tick;
  else v = atrAtLast(raw, box.atrLength);
  return Math.max(tick, v);
}

/** Price path a bar is assumed to walk (OHLC source): up bars O→L→H→C, down
 *  bars O→H→L→C. */
function ohlcPath(r: OHLC): number[] {
  return r.close >= r.open ? [r.open, r.low, r.high, r.close] : [r.open, r.high, r.low, r.close];
}

const round = (v: number, tick: number) => Math.round(v / tick) * tick;

// ── Heikin Ashi ─────────────────────────────────────────────────────────────

export type Candle = { time: Time; open: number; high: number; low: number; close: number };

export function toHeikinAshi(raw: OHLC[]): Candle[] {
  const out: Candle[] = [];
  let prevO = 0;
  let prevC = 0;
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i];
    const c = (r.open + r.high + r.low + r.close) / 4;
    const o = i === 0 ? (r.open + r.close) / 2 : (prevO + prevC) / 2;
    out.push({ time: r.time, open: o, high: Math.max(r.high, o, c), low: Math.min(r.low, o, c), close: c });
    prevO = o;
    prevC = c;
  }
  return out;
}

// ── Renko ───────────────────────────────────────────────────────────────────

export type Brick = Candle & { up: boolean; proj: boolean };

/** Renko bricks. Up brick when price reaches the last brick's top + box, down
 *  brick when it reaches its bottom − box (two-box reversal). The wick of a
 *  brick is the extreme reached against it since the previous brick. */
export function toRenko(raw: OHLC[], box: number, source: "Close" | "OHLC", lastForming: boolean): Brick[] {
  if (raw.length === 0 || !(box > 0)) return [];
  const tick = minTickFor(raw[raw.length - 1].close);
    const out: Brick[] = [];
  let hi = round(Math.floor(raw[0].open / box) * box, tick);
  let lo = hi;
  let minSince = raw[0].open;
  let maxSince = raw[0].open;
  for (let i = 0; i < raw.length; i++) {
    const proj = lastForming && i === raw.length - 1;
    const pts = source === "OHLC" ? ohlcPath(raw[i]) : [raw[i].close];
    for (const p of pts) {
      minSince = Math.min(minSince, p);
      maxSince = Math.max(maxSince, p);
      while (p >= hi + box - 1e-9) {
        const open = hi;
        const close = round(hi + box, tick);
        out.push({ time: 0 as Time, open, close, high: close, low: Math.min(open, minSince), up: true, proj });
        lo = open;
        hi = close;
        minSince = close;
        maxSince = close;
      }
      while (p <= lo - box + 1e-9) {
        const open = lo;
        const close = round(lo - box, tick);
        out.push({ time: 0 as Time, open, close, high: Math.max(open, maxSince), low: close, up: false, proj });
        hi = open;
        lo = close;
        minSince = close;
        maxSince = close;
      }
    }
  }
  return assignTimes(out, raw);
}

// ── Line break ──────────────────────────────────────────────────────────────

/** Line break: a new up line when the close is above the high of the last
 *  `n` lines, a new down line when it is below their low. */
export function toLineBreak(raw: OHLC[], n: number, lastForming: boolean): Brick[] {
  if (raw.length === 0) return [];
    const lines: Brick[] = [];
  const k = Math.max(1, Math.round(n));
  let base = raw[0].close;
  for (let i = 1; i < raw.length; i++) {
    const c = raw[i].close;
    const proj = lastForming && i === raw.length - 1;
    if (lines.length === 0) {
      if (c !== base) lines.push({ time: 0 as Time, open: base, close: c, high: Math.max(base, c), low: Math.min(base, c), up: c > base, proj });
      continue;
    }
    const last = lines.slice(-k);
    const hi = Math.max(...last.map((l) => l.high));
    const lo = Math.min(...last.map((l) => l.low));
    const prev = lines[lines.length - 1];
    if (c > hi) {
      const open = prev.up ? prev.close : prev.open;
      lines.push({ time: 0 as Time, open, close: c, high: c, low: open, up: true, proj });
    } else if (c < lo) {
      const open = prev.up ? prev.open : prev.close;
      lines.push({ time: 0 as Time, open, close: c, high: open, low: c, up: false, proj });
    }
    base = c;
  }
  return assignTimes(lines, raw);
}

// ── Range bars ──────────────────────────────────────────────────────────────

/** Range bars of height `range`: a bar closes once its high − low reaches the
 *  range. Phantom bars fill untraded gaps between source bars with virtual
 *  bars; without them a gap opens the next bar at the new price. The still
 *  open last bar is a projection bar while the source bar is forming. */
export function toRangeBars(raw: OHLC[], range: number, phantom: boolean, lastForming: boolean): Brick[] {
  if (raw.length === 0 || !(range > 0)) return [];
    const out: Brick[] = [];
  let open = raw[0].open;
  let hi = open;
  let lo = open;
  let last = open;
  const close = (c: number) => {
    out.push({ time: 0 as Time, open, close: c, high: Math.max(hi, c), low: Math.min(lo, c), up: c >= open, proj: false });
    open = c;
    hi = c;
    lo = c;
  };
  for (let i = 0; i < raw.length; i++) {
    const pts = ohlcPath(raw[i]);
    if (i > 0 && !phantom && Math.abs(pts[0] - last) >= range) {
      // Untraded gap, phantom bars off: finish the running bar at the last
      // traded price and open the next one at the gap price.
      if (hi !== lo) close(last);
      open = hi = lo = last = pts[0];
    }
    for (const p of pts) {
      for (;;) {
        if (p > hi) {
          if (p - lo >= range) { hi = lo + range; close(hi); continue; }
          hi = p;
        }
        if (p < lo) {
          if (hi - p >= range) { lo = hi - range; close(lo); continue; }
          lo = p;
        }
        break;
      }
      last = p;
    }
  }
  if (lastForming && hi !== lo) out.push({ time: 0 as Time, open, close: last, high: hi, low: lo, up: last >= open, proj: true });
  return assignTimes(out, raw);
}

/** Range size: a Range chart normally takes an interval in ticks (range
 *  intervals such as "10R"), which this app's interval system does not have;
 *  bars use the loaded bars' average high−low as the range. */
export function rangeSize(raw: OHLC[]): number {
  if (raw.length === 0) return 0;
  let s = 0;
  for (const r of raw) s += r.high - r.low;
  return Math.max(minTickFor(raw[raw.length - 1].close), s / raw.length);
}

// ── Kagi ────────────────────────────────────────────────────────────────────

export type KagiItem = {
  time: Time;
  start: number;
  end: number;
  /** Vertical sub-segments: yang (thick, up colour) after price exceeds the
   *  prior shoulder, yin (thin, down colour) after it breaks the prior waist. */
  segments: { from: number; to: number; yang: boolean }[];
  proj: boolean;
};

/** Kagi on closes: a column extends while price keeps its direction; a
 *  counter-move of at least `rev` starts a new column. */
export function toKagi(raw: OHLC[], rev: number, lastForming: boolean): KagiItem[] {
  if (raw.length === 0 || !(rev > 0)) return [];
    const cols: { start: number; end: number; proj: boolean }[] = [];
  const anchor = raw[0].close;
  let dir: 1 | -1 | 0 = 0;
  for (let i = 1; i < raw.length; i++) {
    const c = raw[i].close;
    const proj = lastForming && i === raw.length - 1;
    if (dir === 0) {
      if (Math.abs(c - anchor) >= rev) {
        dir = c > anchor ? 1 : -1;
        cols.push({ start: anchor, end: c, proj });
      }
      continue;
    }
    const cur = cols[cols.length - 1];
    if ((dir === 1 && c > cur.end) || (dir === -1 && c < cur.end)) {
      cur.end = c;
      cur.proj = cur.proj || proj;
    } else if ((dir === 1 && cur.end - c >= rev) || (dir === -1 && c - cur.end >= rev)) {
      cols.push({ start: cur.end, end: c, proj });
      dir = dir === 1 ? -1 : 1;
    }
  }
  const items: KagiItem[] = [];
  let yang = cols.length > 0 && cols[0].end >= cols[0].start;
  let shoulder = -Infinity;
  let waist = Infinity;
  for (let i = 0; i < cols.length; i++) {
    const { start, end, proj } = cols[i];
    const rising = end >= start;
    const segments: KagiItem["segments"] = [];
    if (rising && !yang && shoulder > start && shoulder < end) {
      segments.push({ from: start, to: shoulder, yang: false }, { from: shoulder, to: end, yang: true });
      yang = true;
    } else if (!rising && yang && waist < start && waist > end) {
      segments.push({ from: start, to: waist, yang: true }, { from: waist, to: end, yang: false });
      yang = false;
    } else {
      segments.push({ from: start, to: end, yang });
    }
    if (i > 0) {
      const prev = cols[i - 1];
      shoulder = Math.max(prev.start, prev.end);
      waist = Math.min(prev.start, prev.end);
    }
    items.push({ time: 0 as Time, start, end, segments, proj });
  }
  return assignTimes(items, raw);
}

// ── Point & figure ──────────────────────────────────────────────────────────

export type PnfItem = {
  time: Time; kind: "x" | "o"; min: number; max: number; box: number; proj: boolean;
  /** One step back building: the single box of the other kind the column
   *  started with (its top price). */
  extra?: { kind: "x" | "o"; top: number };
};

/** Point & figure. Source "Close" uses closes; "HL" extends X columns with
 *  highs and O columns with lows (reversals tested on the opposite extreme).
 *  A reversal needs `reversal` boxes. One step back building (reversal 1):
 *  a one-box column that reverses keeps the new box in the same column. */
export function toPnf(raw: OHLC[], box: number, reversal: number, source: "HL" | "Close", oneStepBack: boolean, lastForming: boolean): PnfItem[] {
  if (raw.length === 0 || !(box > 0)) return [];
  const rev = Math.max(1, Math.round(reversal));
    // Box k spans (k·box − box, k·box]; a column lists its boxes' tops min..max.
  const floor = (p: number) => Math.floor(p / box + 1e-9) * box;
  type Col = { kind: "x" | "o"; min: number; max: number; proj: boolean; extra?: PnfItem["extra"] };
  const cols: Col[] = [];
  const anchor = floor(raw[0].close);
  for (let i = 1; i < raw.length; i++) {
    const r = raw[i];
    const proj = lastForming && i === raw.length - 1;
    const up = source === "HL" ? r.high : r.close;
    const dn = source === "HL" ? r.low : r.close;
    const cur = cols[cols.length - 1];
    if (!cur) {
      if (up >= anchor + box) cols.push({ kind: "x", min: anchor + box, max: floor(up), proj });
      else if (dn <= anchor - box) cols.push({ kind: "o", min: floor(dn) + box, max: anchor, proj });
      continue;
    }
    if (cur.kind === "x") {
      if (up >= cur.max + box) { cur.max = floor(up); cur.proj ||= proj; }
      else if (dn <= cur.max - rev * box) {
        if (oneStepBack && rev === 1 && cur.max === cur.min && !cur.extra) {
          cur.extra = { kind: "x", top: cur.max };
          cur.kind = "o"; cur.max = cur.max - box; cur.min = floor(dn) + box; cur.proj ||= proj;
        } else cols.push({ kind: "o", min: floor(dn) + box, max: cur.max - box, proj });
      }
    } else {
      if (dn <= cur.min - box) { cur.min = floor(dn) + box; cur.proj ||= proj; }
      else if (up >= cur.min + rev * box) {
        if (oneStepBack && rev === 1 && cur.max === cur.min && !cur.extra) {
          cur.extra = { kind: "o", top: cur.min };
          cur.kind = "x"; cur.min = cur.min + box; cur.max = floor(up); cur.proj ||= proj;
        } else cols.push({ kind: "x", min: cur.min + box, max: floor(up), proj });
      }
    }
  }
  return assignTimes(cols.filter((c) => c.max >= c.min).map((c) => ({ time: 0 as Time, kind: c.kind, min: c.min, max: c.max, box, proj: c.proj, extra: c.extra })), raw);
}
