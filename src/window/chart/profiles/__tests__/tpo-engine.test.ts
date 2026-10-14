import { describe, expect, it } from "vitest";
import type { Bar } from "oakscriptjs";
import { autoTicksPerRow, buildTpo } from "../tpo-engine";

const bar = (i: number, low: number, high: number, volume = 0, open = low, close = high): Bar =>
  ({ time: 1_000 + i * 1800, open, high, low, close, volume }) as Bar;

describe("autoTicksPerRow", () => {
  it("range in ticks / 80 rounded to a 5 x 10^(digits - 2) step", () => {
    // 100 -> 200 at 0.01: 10,000 ticks / 80 = 125, step 50 -> round(2.5) x 50 = 150.
    expect(autoTicksPerRow([bar(0, 100, 200)], 0.01)).toBe(150);
    // 100 -> 120: 2,000 ticks / 80 = 25, step 5 -> 25.
    expect(autoTicksPerRow([bar(0, 100, 120)], 0.01)).toBe(25);
  });

  it("at least 1, at most 1,000,000", () => {
    expect(autoTicksPerRow([bar(0, 100, 101)], 0.01)).toBe(1);
    expect(autoTicksPerRow([bar(0, 100, 100)], 0.01)).toBe(1);
    expect(autoTicksPerRow([], 0.01)).toBe(1);
    expect(autoTicksPerRow([bar(0, 0, 1e7)], 0.01)).toBe(1_000_000);
  });

  it("reads the last 300 bars only", () => {
    const bars = [bar(0, 1, 10_000), ...Array.from({ length: 300 }, (_, i) => bar(i + 1, 100, 120))];
    expect(autoTicksPerRow(bars, 0.01)).toBe(25);
  });
});

describe("buildTpo", () => {
  // Blocks (tick 1, 1 tick per row): A 10-12, B 11-13, C 11-12, D 9-11, E 14-15.
  // Rows marked: 9 [D], 10 [A, D], 11 [A, B, C], 12 [B], 13 none, 14 [E].
  const bars = [bar(0, 10, 12, 100, 10.5, 11.5), bar(1, 11, 13), bar(2, 11, 12), bar(3, 9, 11), bar(4, 14, 15, 0, 14, 14.5)];
  const idx = [0, 1, 2, 3, 4];
  const p = buildTpo(bars, idx, 1, 1, 70, 2)!;

  it("rows: a high on a row's bottom edge does not mark that row", () => {
    expect(p.rows).toEqual([
      { row: 9, blocks: [3] },
      { row: 10, blocks: [0, 3] },
      { row: 11, blocks: [0, 1, 2] },
      { row: 12, blocks: [1] },
      { row: 14, blocks: [4] },
    ]);
    expect(p.rowSize).toBe(1);
    expect(p.blockCount).toBe(5);
    expect(p.blockTimes).toEqual([1000, 2800, 4600, 6400, 8200]);
  });

  it("POC, value area (70 %) and midpoint", () => {
    expect(p.poc).toBe(11);
    // From the POC (3 of 8 blocks): row 10 (2) beats row 12 (1) -> 5; the next row would exceed 5.6.
    expect([p.val, p.vah]).toEqual([10, 11]);
    expect(p.mid).toBe(12);
  });

  it("single prints: runs of one-block rows that reach neither extreme", () => {
    expect(p.singlePrints).toEqual([12]);
  });

  it("poor high / low only when the extreme row has more than one block", () => {
    expect(p.poorHigh).toBeNull();
    expect(p.poorLow).toBeNull();
    const q = buildTpo([bar(0, 10, 12), bar(1, 10, 12), bar(2, 11, 12)], [0, 1, 2], 1, 1, 70, 1)!;
    expect(q.poorHigh).toBe(11);
    expect(q.poorLow).toBe(10);
  });

  it("initial balance: rows of the first N blocks", () => {
    expect(p.ib).toEqual([10, 12]);
    expect(buildTpo(bars, idx, 1, 1, 70, 0)!.ib).toBeNull();
  });

  it("volume spread over the rows in proportion to the overlap", () => {
    expect(p.volume).toEqual([{ row: 10, volume: 50 }, { row: 11, volume: 50 }]);
    // Equal rows: the higher one is the POC.
    expect(p.volumePoc).toBe(11);
    expect([p.volumeVal, p.volumeVah]).toEqual([11, 11]);
  });

  it("open / close of the profile", () => {
    expect(p.open).toBe(10.5);
    expect(p.close).toBe(14.5);
  });

  it("several ticks per row and a block subset", () => {
    // Tick 0.25, 4 ticks per row (1.00 rows): 10.10 rounds to 10.00, 11.90 to 12.00.
    const q = buildTpo([bar(0, 10.1, 11.9), bar(1, 50, 60)], [0], 0.25, 4, 70, 1)!;
    expect(q.rowSize).toBe(1);
    expect(q.rows.map((r) => r.row)).toEqual([10, 11]);
    expect(q.blockCount).toBe(1);
  });

  it("a bar without range puts its volume on its row; no volume: no volume levels", () => {
    const q = buildTpo([bar(0, 10, 10, 30)], [0], 1, 1, 70, 1)!;
    expect(q.rows).toEqual([{ row: 10, blocks: [0] }]);
    expect(q.volume).toEqual([{ row: 10, volume: 30 }]);
    const n = buildTpo([bar(0, 10, 12)], [0], 1, 1, 70, 1)!;
    expect(n.volume).toEqual([]);
    expect(n.volumePoc).toBeNull();
  });

  it("no blocks: null", () => {
    expect(buildTpo(bars, [], 1, 1, 70, 1)).toBeNull();
  });
});
