// The scale each study is on (study-scales.ts), read with the chart's scale layout (scale-layout.ts) as the chart
// builds it: merged into / out of a pane, pinned to a new left / right scale, a scale moved to the other side.
import { describe, expect, it, vi } from "vitest";
import type { IChartApi } from "lightweight-charts";
import { StudyScales } from "../study-scales";
import { PaneAllocator, type PanedInstance } from "../pane-allocator";
import { defaultIndicatorOptions, type IndicatorOptions, type StudyScale } from "../indicator-options";
import { ScaleLayout, type ScaleKey, type Side } from "../../scales/scale-layout";

// Price studies are drawn over the series by default; Volume draws on a hidden scale of its own.
vi.mock("../registry", () => {
  const entries: Record<string, { overlay: boolean; metadata: Record<string, unknown> }> = {
    sma: { overlay: true, metadata: {} },
    ema: { overlay: true, metadata: {} },
    rsi: { overlay: false, metadata: {} },
    macd: { overlay: false, metadata: {} },
    volume: { overlay: false, metadata: { ownScaleId: "vol" } },
  };
  return { getIndicatorEntry: (id: string) => entries[id.split("#")[0]] };
});

type Inst = PanedInstance & { owner?: { setPaneIndex(i: number): void } };

/** A chart: the series on the right scale of pane 0, studies placed by `place`. */
function chart(place: Record<string, Partial<Inst>>) {
  const instances = new Map<string, Inst>();
  for (const [id, p] of Object.entries(place)) {
    instances.set(id, { paneIndex: 0, overlay: false, group: id, layer: { setPaneIndex: () => {} }, ...p });
  }
  const options = new Map<string, IndicatorOptions>();
  const panes = new PaneAllocator({ panes: () => [] } as unknown as IChartApi, instances, () => {});
  // The scales of the chart as it lays them out: the series, the studies' scales, a new scale given in order.
  const layout = (): ScaleLayout => new ScaleLayout([{ source: "_series", pane: panes.mainPane, key: "right" }, ...scales.uses()]);
  const host = {
    scaleIds: () => ({ price: "right", pane: "right" }),
    scaleResolve: (id: string, pane: number, key: ScaleKey | "new"): { key: ScaleKey; lib: string } | null => {
      const lay = layout();
      const k = key === "new" ? lay.given.get(id) ?? null : key;
      return k ? { key: k, lib: lay.libId(pane, k) } : null;
    },
  };
  const scales: StudyScales = new StudyScales({} as IChartApi, host, instances, options, panes);
  /** Pin `id` to `scale` ("Pin to scale"). */
  const pin = (id: string, scale: StudyScale) => options.set(id, { ...defaultIndicatorOptions(), scale });
  /** "Pin to new left / right scale": the key the menu gives. */
  const pinNew = (id: string, side: Side) => {
    const key = layout().newKeyFor(instances.get(id)!.paneIndex, side)!;
    pin(id, key);
    return key;
  };
  return { instances, options, panes, scales, layout, pin, pinNew };
}

describe("StudyScales", () => {
  it("over the series: a price study on the series' scale, another study on a new one", () => {
    const { scales, layout } = chart({ sma: { overlay: true, group: null }, rsi: { overlay: true, group: null } });
    expect(scales.keyOf("sma")).toBe("right");
    expect(scales.keyOf("rsi")).toBe("new");
    // The new scale goes to the side with fewer scales.
    expect(scales.scaleOf("rsi")).toBe("left");
    expect(layout().sourcesOn(0, "right")).toEqual(["_series", "sma"]);
  });

  it("a study in its own pane is on the pane's scale; Volume on its own hidden scale", () => {
    const { scales } = chart({ rsi: { paneIndex: 1 }, volume: { paneIndex: 0, overlay: true, group: null } });
    expect(scales.keyOf("rsi")).toBe("right");
    expect(scales.keyOf("volume")).toBe("own");
    expect(scales.scaleOf("volume")).toBe("none");
    expect(scales.uses().map((u) => u.source)).toEqual(["rsi"]);
  });

  it("merged into an oscillator's pane: a price study or another oscillator takes a new scale", () => {
    const { scales } = chart({
      rsi: { paneIndex: 1 },
      sma: { paneIndex: 1, group: "rsi" },
      macd: { paneIndex: 1, group: "rsi" },
    });
    expect(scales.keyOf("rsi")).toBe("right");
    expect(scales.keyOf("sma")).toBe("new");
    expect(scales.keyOf("macd")).toBe("new");
    // One new scale each, to the side with fewer scales.
    expect(scales.scaleOf("sma")).toBe("left");
    expect(scales.scaleOf("macd")).toBe("right#1");
  });

  it("merged into the pane of a price study moved to its own pane: it shares that study's scale", () => {
    const { scales, pin } = chart({ sma: { paneIndex: 1, group: "sma" }, ema: { paneIndex: 1, group: "sma" } });
    expect(scales.keyOf("ema")).toBe("right");
    // The pane's lead pinned to the left: the price study follows it there.
    pin("sma", "left");
    expect(scales.keyOf("ema")).toBe("left");
  });

  it("merged into a compared symbol's pane: a price study takes the pane's scale", () => {
    const { scales } = chart({
      cmp: { paneIndex: 1, group: "cmp", owner: { setPaneIndex: () => {} } },
      sma: { paneIndex: 1, group: "cmp" },
    });
    expect(scales.keyOf("cmp")).toBeNull();
    expect(scales.keyOf("sma")).toBe("right");
  });

  it("unmerged into a pane of its own: the pane's scale", () => {
    const { scales, instances } = chart({ rsi: { paneIndex: 1 }, sma: { paneIndex: 1, group: "rsi" } });
    expect(scales.keyOf("sma")).toBe("new");
    instances.set("sma", { ...instances.get("sma")!, paneIndex: 2, group: "sma" });
    expect(scales.keyOf("sma")).toBe("right");
  });

  it("pinned to a new left scale, then to a new right scale", () => {
    const { scales, layout, pinNew } = chart({ sma: { overlay: true, group: null } });
    expect(pinNew("sma", "left")).toBe("left");
    expect(scales.keyOf("sma")).toBe("left");
    expect(scales.scaleOf("sma")).toBe("left");
    expect(layout().scales(0, "left")).toEqual(["left"]);
    expect(pinNew("sma", "right")).toBe("right#1");
    expect(scales.scaleOf("sma")).toBe("right#1");
    expect(layout().scales(0, "right")).toEqual(["right", "right#1"]);
    expect(layout().scales(0, "left")).toEqual([]);
    expect(layout().libId(0, "right#1")).toBe("right#1");
  });

  it("moves a scale to the other side: its studies are pinned to a new scale there", () => {
    const { scales, layout, pin, options } = chart({
      rsi: { overlay: true, group: null },
      macd: { overlay: true, group: null },
    });
    pin("rsi", "right#1");
    pin("macd", "right#1");
    expect(layout().sourcesOn(0, "right#1")).toEqual(["rsi", "macd"]);
    // "Move scale to left": every source of the scale goes to the key a new left scale takes.
    const to = layout().newKeyFor(0, "left")!;
    for (const id of layout().sourcesOn(0, "right#1")) pin(id, to);
    expect(to).toBe("left");
    expect(scales.scaleOf("rsi")).toBe("left");
    expect(scales.scaleOf("macd")).toBe("left");
    expect(layout().scales(0, "right")).toEqual(["right"]);
    expect(layout().sourcesOn(0, "left")).toEqual(["rsi", "macd"]);
    expect(options.get("rsi")!.scale).toBe("left");
  });

  it("no scale: a hidden scale of its own, off the layout", () => {
    const { scales, pin } = chart({ sma: { overlay: true, group: null } });
    pin("sma", "none");
    expect(scales.keyOf("sma")).toBe("none");
    expect(scales.scaleOf("sma")).toBe("none");
    expect(scales.uses()).toEqual([]);
    expect(scales.detached("sma", { paneIndex: 0, overlay: true, group: null, layer: { setPaneIndex: () => {} } })).toEqual({ id: "src:sma", axis: false });
  });

  it("the series shares a study pane: on the pane's price scale only when its lead shows prices", () => {
    const { panes, scales } = chart({ rsi: { paneIndex: 1 }, sma: { paneIndex: 2, group: "sma" } });
    panes.mainPane = 1;
    expect(scales.seriesSharesPriceScale()).toBe(false);
    panes.mainPane = 2;
    expect(scales.seriesSharesPriceScale()).toBe(true);
    panes.mainPane = 0;
    expect(scales.seriesSharesPriceScale()).toBe(false);
  });
});
