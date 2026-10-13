/*
 * Time price opportunity engine (#48): the profile of a period from its bars
 * of the block size. Rules measured on the reference outputs (13 profiles,
 * exact):
 *
 * - Bars of the block size (30m default) of the chart symbol; block k of a
 *   profile = its k-th bar; letters A-Z then a-z.
 * - Rows of `ticks per row` ticks on the absolute price grid; a block marks
 *   every row its low..high touches (high and low rounded half-up to the
 *   tick, a high on a row's bottom edge does not mark that row).
 * - Auto rows: range of the last 300 chart bars in ticks / 80 (at least / 1000),
 *   rounded to a step of 5 x 10^(digits - 2) (at least 5), 1..1000000.
 * - POC: row with the most blocks (equal: closest to the middle, then the
 *   higher). Value area on block counts: from the POC, the larger of the next
 *   rows above / below (equal: closer to the POC, then the higher), added
 *   while it fits in VA % of all blocks. Midpoint: middle row (half up).
 * - Single prints: runs of one-block rows that do not reach the profile's
 *   extremes, marked at their first (lowest) row. Poor high / low: an extreme
 *   row with more than one block.
 * - Volume rows: the block bars' volume spread over the rows in proportion
 *   to the overlap; volume POC / VA by the volume profile rules.
 * - Initial balance: the rows of the first N blocks.
 */
import type { Bar } from "oakscriptjs";
import { pocOf, toTicks, valueArea } from "./vbp-engine";
import type { TpoStyle } from "./tpo-style";

/** One TPO profile: chart bars, row grid (absolute row indexes) and levels. */
export type TpoProfile = {
  i0: number;
  i1: number;
  /** Row height (price). Row r covers [r x rowSize, (r + 1) x rowSize). */
  rowSize: number;
  /** Block indexes per row, rows ascending. */
  rows: { row: number; blocks: number[] }[];
  /** Number of blocks in the profile. */
  blockCount: number;
  /** Start time (seconds) of each block bar: split / merge points. */
  blockTimes: number[];
  poc: number;
  vah: number;
  val: number;
  mid: number;
  singlePrints: number[];
  poorHigh: number | null;
  poorLow: number | null;
  ib: [number, number] | null;
  volume: { row: number; volume: number }[];
  volumePoc: number | null;
  volumeVah: number | null;
  volumeVal: number | null;
  open: number;
  close: number;
  /** Bar index where an extended level stops (-1: right edge; null: not extended). */
  extend: Partial<Record<"poc" | "vah" | "val" | "poorHigh" | "poorLow" | "volumePoc" | "volumeVah" | "volumeVal", number | null>>;
  singleExtend: (number | null)[];
};

export type TpoDraw = { profiles: TpoProfile[]; style: TpoStyle };

/** Auto ticks per row from the last 300 chart bars. */
export function autoTicksPerRow(bars: Bar[], tick: number): number {
  if (!bars.length) return 1;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = Math.max(0, bars.length - 300); i < bars.length; i++) {
    lo = Math.min(lo, bars[i].low);
    hi = Math.max(hi, bars[i].high);
  }
  const n = (hi - lo) / tick;
  const d = Math.max(n / 80, n / 1000);
  if (!(d > 0)) return 1;
  const p = 5 * Math.max(1, 10 ** (Math.floor(Math.log10(d)) - 1));
  return Math.min(1e6, Math.max(1, Math.round(d / p) * p));
}

/** Levels of one profile from its block bars (indexes into `bars`, in time order; block k = the k-th). */
export function buildTpo(bars: Bar[], idx: readonly number[], tick: number, tpr: number, vaPct: number, ibBlocks: number): Omit<TpoProfile, "i0" | "i1" | "extend" | "singleExtend"> | null {
  if (idx.length === 0) return null;
  const marks = new Map<number, number[]>();
  const vol = new Map<number, number>();
  for (let k = 0; k < idx.length; k++) {
    const b = bars[idx[k]];
    const lo = toTicks(b.low, tick);
    const hi = toTicks(b.high, tick);
    const r0 = Math.floor(lo / tpr);
    const r1 = Math.max(r0, Math.ceil(hi / tpr) - 1);
    for (let r = r0; r <= r1; r++) {
      let list = marks.get(r);
      if (!list) marks.set(r, (list = []));
      list.push(k);
    }
    // Volume in proportion to the overlap (a bar without range: its row).
    const v = b.volume ?? 0;
    if (v > 0) {
      if (hi <= lo) vol.set(r0, (vol.get(r0) ?? 0) + v);
      else for (let r = r0; r <= r1; r++) {
        const a = Math.max(lo, r * tpr);
        const c = Math.min(hi, (r + 1) * tpr);
        if (c > a) vol.set(r, (vol.get(r) ?? 0) + (v * (c - a)) / (hi - lo));
      }
    }
  }
  const keys = [...marks.keys()].sort((a, b) => a - b);
  const minRow = keys[0];
  const maxRow = keys[keys.length - 1];
  // Dense arrays over minRow..maxRow for the POC / value area rules.
  const counts = new Array<number>(maxRow - minRow + 1).fill(0);
  for (const [r, list] of marks) counts[r - minRow] = list.length;
  const pocI = pocOf(counts);
  const [vaLo, vaHi] = valueArea(counts, pocI, vaPct);
  const singles: number[] = [];
  for (let r = minRow; r <= maxRow; r++) {
    if (counts[r - minRow] !== 1 || (r > minRow && counts[r - 1 - minRow] === 1)) continue;
    // A run of single prints that reaches neither extreme, marked at its first row.
    let end = r;
    while (end + 1 <= maxRow && counts[end + 1 - minRow] === 1) end++;
    if (r > minRow && end < maxRow) singles.push(r);
  }
  let ib: [number, number] | null = null;
  for (const [r, list] of marks) {
    if (!list.some((k) => k < ibBlocks)) continue;
    ib = ib ? [Math.min(ib[0], r), Math.max(ib[1], r)] : [r, r];
  }
  const volume = [...vol.entries()].sort((a, b) => a[0] - b[0]).map(([row, v]) => ({ row, volume: v }));
  let volumePoc: number | null = null;
  let volumeVah: number | null = null;
  let volumeVal: number | null = null;
  if (volume.length) {
    const v0 = volume[0].row;
    const dense = new Array<number>(volume[volume.length - 1].row - v0 + 1).fill(0);
    for (const v of volume) dense[v.row - v0] = v.volume;
    const p = pocOf(dense);
    const [a, b] = valueArea(dense, p, vaPct);
    volumePoc = v0 + p;
    volumeVal = v0 + a;
    volumeVah = v0 + b;
  }
  return {
    rowSize: tpr * tick,
    rows: keys.map((row) => ({ row, blocks: marks.get(row)! })),
    blockCount: idx.length,
    blockTimes: idx.map((i) => bars[i].time as number),
    poc: minRow + pocI,
    vah: minRow + vaHi,
    val: minRow + vaLo,
    mid: Math.floor((minRow + maxRow) / 2 + 0.5),
    singlePrints: singles,
    poorHigh: counts[counts.length - 1] > 1 ? maxRow : null,
    poorLow: counts[0] > 1 ? minRow : null,
    ib,
    volume,
    volumePoc,
    volumeVah,
    volumeVal,
    open: bars[idx[0]].open,
    close: bars[idx[idx.length - 1]].close,
  };
}

