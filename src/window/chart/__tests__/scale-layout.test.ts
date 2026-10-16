import { describe, expect, it } from "vitest";
import { ScaleLayout, newScaleKey, scaleLetter, keyOrder, isScaleKey, libScaleId } from "../scales/scale-layout";

describe("scale keys", () => {
  it("parses keys and orders", () => {
    expect(isScaleKey("right")).toBe(true);
    expect(isScaleKey("left#3")).toBe(true);
    expect(isScaleKey("src:x")).toBe(false);
    expect(keyOrder("right")).toBe(0);
    expect(keyOrder("right#4")).toBe(4);
    expect(libScaleId("left", 0)).toBe("left");
    expect(libScaleId("left", 2)).toBe("left#2");
  });
  it("new keys go to the end of a side", () => {
    expect(newScaleKey("left", ["right"])).toBe("left");
    expect(newScaleKey("right", ["right"])).toBe("right#1");
    expect(newScaleKey("right", ["right", "right#3"])).toBe("right#4");
  });
  it("letters: right A.., left Z..", () => {
    expect(scaleLetter("right", 0)).toBe("A");
    expect(scaleLetter("right", 7)).toBe("H");
    expect(scaleLetter("left", 0)).toBe("Z");
    expect(scaleLetter("left", 1)).toBe("Y");
    expect(scaleLetter("left", 8)).toBe("");
  });
});

describe("ScaleLayout", () => {
  it("auto: new scales to the side with fewer (left first, then right)", () => {
    // Reference capture: series on the right, two "New price scale" symbols -> left, then right.
    const l = new ScaleLayout([
      { source: "_series", pane: 0, key: "right" },
      { source: "a", pane: 0, key: "new" },
      { source: "b", pane: 0, key: "new" },
    ]);
    expect(l.given.get("a")).toBe("left");
    expect(l.given.get("b")).toBe("right#1");
    expect(l.scales(0, "right")).toEqual(["right", "right#1"]);
    expect(l.libId(0, "right#1")).toBe("right#1");
    expect(l.letter(0, "right#1")).toBe("B");
    expect(l.slotCounts()).toEqual({ left: 1, right: 2, total: 3 });
  });

  it("compacts: an emptied scale's followers move in", () => {
    const l = new ScaleLayout([
      { source: "_series", pane: 0, key: "right" },
      { source: "b", pane: 0, key: "right#3" },
    ]);
    expect(l.slotOf(0, "right#3")).toEqual({ side: "right", index: 1 });
    expect(l.libId(0, "right#3")).toBe("right#1");
    const m = new ScaleLayout([{ source: "x", pane: 1, key: "right#2" }]);
    expect(m.libId(1, "right#2")).toBe("right");
  });

  it("stack modes put every scale on one side, the side's own first", () => {
    const uses = [
      { source: "_series", pane: 0, key: "right" },
      { source: "a", pane: 0, key: "left" },
      { source: "b", pane: 0, key: "right#1" },
    ];
    const r = new ScaleLayout(uses, "right");
    expect(r.scales(0, "right")).toEqual(["right", "right#1", "left"]);
    expect(r.scales(0, "left")).toEqual([]);
    expect(r.libId(0, "left")).toBe("right#2");
    const nl = new ScaleLayout([...uses, { source: "c", pane: 0, key: "new" }], "right");
    expect(nl.given.get("c")).toBe("right#2");
  });

  it("8 scales per pane, then no scale", () => {
    const uses = Array.from({ length: 9 }, (_, i) => ({ source: `s${i}`, pane: 0, key: i === 0 ? "right" : ("new" as const) }));
    const l = new ScaleLayout(uses);
    expect(l.keysIn(0).length).toBe(8);
    expect(l.given.get("s8")).toBeNull();
    expect(l.canCreate(0)).toBe(false);
  });

  it("panes reserve the chart's largest count per side", () => {
    const l = new ScaleLayout([
      { source: "_series", pane: 0, key: "right" },
      { source: "a", pane: 0, key: "right#1" },
      { source: "rsi", pane: 1, key: "right" },
      { source: "x", pane: 1, key: "left" },
      { source: "y", pane: 1, key: "left#1" },
    ]);
    expect(l.slotCounts()).toEqual({ left: 2, right: 2, total: 4 });
    expect(l.extraScales().map((e) => `${e.pane}${e.side}${e.index}`).sort()).toEqual(["0right1", "1left1"]);
    expect(l.sourcesOn(1, "left")).toEqual(["x"]);
  });
});
