import { describe, expect, it } from "vitest";
import type { LayoutExpr } from "../layout-sizes";
import {
  DEFAULT_LAYOUT,
  LAYOUT_NUMBERING,
  LAYOUT_SPECS,
  iconNameForLayout,
  layoutFromVariantId,
  paneCount,
  renumberCharts,
  variantIdForLayout,
  type LayoutId,
} from "../layouts";

function leaves(e: LayoutExpr): number[] {
  return typeof e === "number" ? [e] : (e.slice(1) as LayoutExpr[]).flatMap(leaves);
}

describe("LAYOUT_SPECS", () => {
  const ids = Object.keys(LAYOUT_SPECS) as LayoutId[];

  it("has the 55 templates of the layout menu", () => {
    expect(ids).toHaveLength(55);
  });

  it("every split tree holds each chart index exactly once", () => {
    for (const id of ids) {
      const spec = LAYOUT_SPECS[id];
      const l = leaves(spec.expr).sort((a, b) => a - b);
      expect(l, id).toEqual(Array.from({ length: spec.cells.length }, (_, i) => i));
    }
  });

  it("the pane count is in the id (where the id says it)", () => {
    for (const id of ids) {
      const m = /^(\d+)(?:[hvsc]|c\d+|s-l)?$/.exec(id);
      if (m) expect(paneCount(id), id).toBe(Number(m[1]));
      const parts = /^(\d)-(\d)(?:-(\d))?$/.exec(id);
      if (parts) expect(paneCount(id), id).toBe(parts.slice(1).filter(Boolean).reduce((a, x) => a + Number(x), 0));
    }
    expect(paneCount("s")).toBe(1);
    expect(paneCount("2-2-l")).toBe(4);
    expect(paneCount("2-3-r")).toBe(5);
  });

  it("grids numbered by column", () => {
    expect(LAYOUT_SPECS["4"].cells).toEqual([
      { col: "1", row: "1" },
      { col: "1", row: "2" },
      { col: "2", row: "1" },
      { col: "2", row: "2" },
    ]);
    expect(LAYOUT_SPECS["4"].expr).toEqual(["v", ["h", 0, 2], ["h", 1, 3]]);
  });

  it("row splits use the LCM of the row counts as columns", () => {
    expect(LAYOUT_SPECS["1-2"].cols).toBe(2);
    expect(LAYOUT_SPECS["1-2"].cells).toEqual([
      { col: "1 / span 2", row: "1" },
      { col: "1 / span 1", row: "2" },
      { col: "2 / span 1", row: "2" },
    ]);
    expect(LAYOUT_SPECS["1-2"].expr).toEqual(["v", 0, ["h", 1, 2]]);
    expect(LAYOUT_SPECS["2-3"].cols).toBe(6);
    expect(LAYOUT_SPECS["5-4"].cols).toBe(20);
  });

  it("sidebars: large chart first on the left; mirrored ones start with the large chart", () => {
    expect(LAYOUT_SPECS["3s"].expr).toEqual(["h", 0, ["v", 1, 2]]);
    expect(LAYOUT_SPECS["3r"].expr).toEqual(["h", ["v", 0, 1], 2]);
    expect(LAYOUT_SPECS["4s-l"].expr).toEqual(["h", ["v", 1, 2, 3], 0]);
    expect(LAYOUT_SPECS["4s-l"].cells[0]).toEqual({ col: "2", row: "1 / span 3" });
  });

  it("a single pane is a leaf", () => {
    expect(LAYOUT_SPECS.s.expr).toBe(0);
    expect(DEFAULT_LAYOUT).toBe("s");
  });
});

describe("renumberCharts", () => {
  it("returns the same object when already current", () => {
    const st = { layout: "4", panes: ["a", "b", "c", "d"], numbering: LAYOUT_NUMBERING };
    expect(renumberCharts(st)).toBe(st);
  });

  it("2x2 grid: reading order -> by column, active chart follows", () => {
    const state: { layout: string; panes: string[]; activePane: number; numbering?: number } = { layout: "4", panes: ["a", "b", "c", "d"], activePane: 1 };
    const out = renumberCharts(state);
    expect(out.panes).toEqual(["a", "c", "b", "d"]);
    expect(out.activePane).toBe(2);
    expect(out.numbering).toBe(LAYOUT_NUMBERING);
  });

  it("2-1 and mirrored sidebars", () => {
    expect(renumberCharts({ layout: "2-1", panes: ["a", "b", "c"] }).panes).toEqual(["a", "c", "b"]);
    expect(renumberCharts({ layout: "4s-l", panes: ["s1", "s2", "s3", "big"] }).panes).toEqual(["big", "s1", "s2", "s3"]);
  });

  it("templates without renumbering or with a wrong pane count only get the stamp", () => {
    expect(renumberCharts({ layout: "2h", panes: ["a", "b"] })).toEqual({ layout: "2h", panes: ["a", "b"], numbering: LAYOUT_NUMBERING });
    expect(renumberCharts({ layout: "4", panes: ["a", "b"] })).toEqual({ layout: "4", panes: ["a", "b"], numbering: LAYOUT_NUMBERING });
  });

  it("an invalid active index is kept as is", () => {
    expect(renumberCharts({ layout: "4", panes: [1, 2, 3, 4], activePane: 9 }).activePane).toBe(9);
    expect(renumberCharts({ layout: "4", panes: [1, 2, 3, 4], activePane: 1.5 }).activePane).toBe(1.5);
  });
});

describe("variant ids and icons", () => {
  it("menu variant id <-> layout id", () => {
    expect(layoutFromVariantId("layouts-list-item-3s")).toBe("3s");
    expect(layoutFromVariantId("layouts-list-item-16c4")).toBe("16c4");
    expect(layoutFromVariantId("layouts-list-item-99x")).toBe("s");
    expect(layoutFromVariantId("garbage")).toBe("s");
    expect(variantIdForLayout("2-2-l")).toBe("layouts-list-item-2-2-l");
    expect(layoutFromVariantId(variantIdForLayout("5s-l"))).toBe("5s-l");
  });

  it("icons: per variant, two use the group icon", () => {
    expect(iconNameForLayout("s")).toBe("menu-layout-setup-1");
    expect(iconNameForLayout("14c7")).toBe("menu-layout-setup-14");
    expect(iconNameForLayout("3s")).toBe("menu-layout-setup-layouts-list-item-3s");
  });
});
