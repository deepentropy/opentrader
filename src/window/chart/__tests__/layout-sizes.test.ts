import { describe, expect, it } from "vitest";
import {
  MIN_SHARE,
  SPLITTER_SIZE,
  alignSiblings,
  applyResize,
  cellRects,
  cloneSizing,
  initialSizing,
  sizingFits,
  splitters,
  type LayoutExpr,
  type Sizing,
} from "../layout-sizes";

const two: LayoutExpr = ["h", 0, 1];
const grid4: LayoutExpr = ["v", ["h", 0, 1], ["h", 2, 3]];
const percents = (s: Sizing) => s.map((n) => +n.percent.toFixed(6));

describe("initialSizing / sizingFits / cloneSizing", () => {
  it("equal shares, nested substates", () => {
    expect(initialSizing(0)).toEqual([]);
    expect(initialSizing(two)).toEqual([{ percent: 0.5, substate: undefined }, { percent: 0.5, substate: undefined }]);
    const s = initialSizing(["v", ["h", 0, 1, 2], 3]);
    expect(s[0].percent).toBe(0.5);
    expect(s[0].substate!.map((n) => n.percent)).toEqual([1 / 3, 1 / 3, 1 / 3]);
    expect(s[1].substate).toBeUndefined();
  });

  it("validates the shape of a stored sizing", () => {
    expect(sizingFits(grid4, initialSizing(grid4))).toBe(true);
    expect(sizingFits(0, "anything")).toBe(true);
    expect(sizingFits(two, initialSizing(grid4))).toBe(true); // extra substates under leaves are ignored, but…
    expect(sizingFits(grid4, initialSizing(two))).toBe(false); // …a missing substate is not
    expect(sizingFits(two, [{ percent: 0.5 }])).toBe(false);
    expect(sizingFits(two, [{ percent: 0.5 }, { percent: 0 }])).toBe(false);
    expect(sizingFits(two, [{ percent: 0.5 }, { percent: Number.NaN }])).toBe(false);
    expect(sizingFits(two, null)).toBe(false);
  });

  it("clone is deep", () => {
    const s = initialSizing(grid4);
    const c = cloneSizing(s);
    c[0].substate![0].percent = 0.9;
    expect(s[0].substate![0].percent).toBe(0.5);
  });
});

describe("cellRects", () => {
  it("two charts side by side with a 1 px gap", () => {
    const r = cellRects(two, { left: 0, top: 0, width: 1001, height: 500 }, 1, initialSizing(two));
    expect(r).toEqual([
      { left: 0, top: 0, width: 500, height: 500 },
      { left: 501, top: 0, width: 500, height: 500 },
    ]);
  });

  it("boxes are whole pixels and fill the box exactly", () => {
    const three: LayoutExpr = ["h", 0, 1, 2];
    const r = cellRects(three, { left: 10, top: 0, width: 100, height: 50 }, 0, initialSizing(three));
    expect(r.map((x) => [x.left, x.width])).toEqual([[10, 33], [43, 34], [77, 33]]);
    expect(r.reduce((a, x) => a + x.width, 0)).toBe(100);
  });

  it("nested layout", () => {
    const e: LayoutExpr = ["v", ["h", 0, 1], 2];
    const r = cellRects(e, { left: 0, top: 0, width: 100, height: 201 }, 1, initialSizing(e));
    expect(r).toEqual([
      { left: 0, top: 0, width: 50, height: 100 },
      { left: 51, top: 0, width: 49, height: 100 },
      { left: 0, top: 101, width: 100, height: 100 },
    ]);
  });

  it("follows custom shares; a single leaf takes the whole box", () => {
    const r = cellRects(two, { left: 0, top: 0, width: 100, height: 10 }, 0, [{ percent: 0.25 }, { percent: 0.75 }]);
    expect(r.map((x) => x.width)).toEqual([25, 75]);
    const box = { left: 1, top: 2, width: 3, height: 4 };
    expect(cellRects(0, box, 1, [])).toEqual([box]);
  });
});

describe("splitters", () => {
  it("one band centred on the gap", () => {
    const s = splitters(two, { left: 0, top: 0, width: 1001, height: 500 }, 1, initialSizing(two));
    expect(s).toEqual([
      { level: 0, orientation: "h", indexes: [0], rect: { left: 500 - SPLITTER_SIZE / 2 + 1, top: 0, width: SPLITTER_SIZE, height: 500 }, group: "0-0-h" },
    ]);
  });

  it("grid: one root splitter and one per row, the row ones share a Shift group", () => {
    const s = splitters(grid4, { left: 0, top: 0, width: 201, height: 201 }, 1, initialSizing(grid4));
    expect(s.map((x) => [x.level, x.orientation, x.indexes.join("."), x.group])).toEqual([
      [0, "v", "0", "0-0-v"],
      [1, "h", "0.0", "1-0-h"],
      [1, "h", "1.0", "1-0-h"],
    ]);
    expect(s[0].rect).toEqual({ left: 0, top: 100 - SPLITTER_SIZE / 2 + 1, width: 201, height: SPLITTER_SIZE });
  });

  it("a leaf has none", () => {
    expect(splitters(0, { left: 0, top: 0, width: 10, height: 10 }, 1, [])).toEqual([]);
  });
});

describe("applyResize", () => {
  const box = { left: 0, top: 0, width: 1000, height: 1000 };

  it("moves delta / length between the two neighbours", () => {
    const [sp] = splitters(two, box, 0, initialSizing(two));
    expect(percents(applyResize(two, box, 0, 100, sp, initialSizing(two), false))).toEqual([0.6, 0.4]);
    expect(percents(applyResize(two, box, 0, -250, sp, initialSizing(two), false))).toEqual([0.25, 0.75]);
  });

  it("keeps each share at MIN_SHARE or more", () => {
    const [sp] = splitters(two, box, 0, initialSizing(two));
    expect(percents(applyResize(two, box, 0, 5000, sp, initialSizing(two), false))).toEqual([1 - MIN_SHARE, MIN_SHARE]);
    expect(percents(applyResize(two, box, 0, -5000, sp, initialSizing(two), false))).toEqual([MIN_SHARE, 1 - MIN_SHARE]);
  });

  it("nested: only the dragged row, or every row with Shift", () => {
    const sps = splitters(grid4, box, 0, initialSizing(grid4));
    const row0 = sps[1];
    const one = applyResize(grid4, box, 0, 100, row0, initialSizing(grid4), false);
    expect(percents(one[0].substate!)).toEqual([0.6, 0.4]);
    expect(percents(one[1].substate!)).toEqual([0.5, 0.5]);
    expect(percents(one)).toEqual([0.5, 0.5]);
    const all = applyResize(grid4, box, 0, 100, row0, initialSizing(grid4), true);
    expect(percents(all[1].substate!)).toEqual([0.6, 0.4]);
  });

  it("changes the sizing in place", () => {
    const [sp] = splitters(two, box, 0, initialSizing(two));
    const s = initialSizing(two);
    expect(applyResize(two, box, 0, 100, sp, s, false)).toBe(s);
    expect(s[0].percent).toBeCloseTo(0.6, 12);
  });
});

describe("alignSiblings", () => {
  it("a sibling with more children splits the last share", () => {
    const e: LayoutExpr = ["v", ["h", 0, 1], ["h", 2, 3, 4]];
    const s = initialSizing(e);
    s[0].substate = [{ percent: 0.3 }, { percent: 0.7 }];
    const sp = splitters(e, { left: 0, top: 0, width: 100, height: 100 }, 0, s)[1];
    expect(sp.indexes).toEqual([0, 0]);
    const out = alignSiblings(e, sp, s);
    expect(percents(out[0].substate!)).toEqual([0.3, 0.7]);
    expect(percents(out[1].substate!)).toEqual([0.3, 0.35, 0.35]);
  });

  it("a sibling with fewer children merges the shares it has no child for", () => {
    const e: LayoutExpr = ["v", ["h", 0, 1, 2], ["h", 3, 4]];
    const base = () => {
      const s = initialSizing(e);
      s[0].substate = [{ percent: 0.2 }, { percent: 0.3 }, { percent: 0.5 }];
      return s;
    };
    const sps = splitters(e, { left: 0, top: 0, width: 100, height: 100 }, 0, base());
    // Dragging the first splitter: the sibling keeps the first share, merges the rest.
    expect(percents(alignSiblings(e, sps[1], base())[1].substate!)).toEqual([0.2, 0.8]);
    // Dragging the second splitter: the sibling's splitter follows it.
    expect(sps[2].indexes).toEqual([0, 1]);
    expect(percents(alignSiblings(e, sps[2], base())[1].substate!)).toEqual([0.5, 0.5]);
  });
});
