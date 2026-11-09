// Pane numbering of a chart's studies (pane-allocator.ts) on a stand-in chart: a list of panes the allocator swaps
// and removes, each with the series drawn in it.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IChartApi } from "lightweight-charts";
import { PaneAllocator, type PanedInstance } from "../pane-allocator";

class FakePane {
  series: unknown[] = [];
  preserve = false;
  constructor(readonly name: string) {}
  getSeries() {
    return this.series;
  }
  setPreserveEmptyPane(v: boolean) {
    this.preserve = v;
  }
  preserveEmptyPane() {
    return this.preserve;
  }
}

/** A chart of panes named `names` (top to bottom); a name with a series drawn in it is not empty. */
function fakeChart(names: string[]) {
  const panes = names.map((n) => {
    const p = new FakePane(n);
    p.series.push({});
    return p;
  });
  const chart = {
    panes: () => panes.slice(),
    swapPanes(a: number, b: number) {
      [panes[a], panes[b]] = [panes[b], panes[a]];
    },
    removePane(i: number) {
      panes.splice(i, 1);
    },
  };
  return { chart: chart as unknown as IChartApi, panes, names: () => panes.map((p) => p.name) };
}

/** A study in pane `paneIndex` (stacked unless `overlay`), recording where it is drawn. */
function study(paneIndex: number, group: string | null, overlay = false) {
  const drawnIn: number[] = [];
  const inst: PanedInstance = { paneIndex, overlay, group, layer: { setPaneIndex: (i) => drawnIn.push(i) } };
  return { inst, drawnIn };
}

function setup(names: string[], studies: Record<string, PanedInstance>, mainPane = 0) {
  const c = fakeChart(names);
  const instances = new Map(Object.entries(studies));
  const moved = vi.fn();
  const panes = new PaneAllocator(c.chart, instances, moved);
  panes.mainPane = mainPane;
  panes.resetUsed();
  return { ...c, instances, moved, panes };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("PaneAllocator", () => {
  it("claims the first stacked pane neither the price pane nor a study holds", () => {
    const rsi = study(1, "rsi");
    const { panes } = setup(["price", "rsi"], { rsi: rsi.inst });
    expect(panes.claim()).toBe(2);
    expect(panes.claim()).toBe(3);
    // A price pane lower down is skipped too.
    const low = setup(["a", "price"], {}, 1).panes;
    expect(low.claim()).toBe(0);
    expect(low.claim()).toBe(2);
  });

  it("swaps two study panes: their studies are drawn in each other's pane, the price pane stays", () => {
    const rsi = study(1, "rsi");
    const macd = study(2, "macd");
    const { panes, instances, moved, names } = setup(["price", "rsi", "macd"], { rsi: rsi.inst, macd: macd.inst });
    panes.swap(1, 2);
    expect(names()).toEqual(["price", "macd", "rsi"]);
    expect(instances.get("rsi")!.paneIndex).toBe(2);
    expect(instances.get("macd")!.paneIndex).toBe(1);
    expect(rsi.drawnIn).toEqual([2]);
    expect(macd.drawnIn).toEqual([1]);
    expect(panes.mainPane).toBe(0);
    expect(moved).not.toHaveBeenCalled();
  });

  it("swaps the price pane with a study pane: the price pane moved", () => {
    const rsi = study(1, "rsi");
    const sma = study(0, null, true);
    const { panes, instances, moved } = setup(["price", "rsi"], { rsi: rsi.inst, sma: sma.inst });
    panes.swap(0, 1);
    expect(panes.mainPane).toBe(1);
    expect(instances.get("rsi")!.paneIndex).toBe(0);
    // A study drawn over the series goes with the price pane.
    expect(instances.get("sma")!.paneIndex).toBe(1);
    expect(moved).toHaveBeenCalledTimes(1);
    // The pane the study left is free again, the price pane is never claimed.
    expect(panes.claim()).toBe(2);
  });

  it("ignores a swap out of range or with itself", () => {
    const rsi = study(1, "rsi");
    const { panes, names } = setup(["price", "rsi"], { rsi: rsi.inst });
    panes.swap(1, 1);
    panes.swap(1, 5);
    expect(names()).toEqual(["price", "rsi"]);
    expect(rsi.drawnIn).toEqual([]);
  });

  it("renumbers the panes below a closed pane", () => {
    const macd = study(2, "macd");
    const { panes, chart, instances, moved, names } = setup(["price", "rsi", "macd"], { macd: macd.inst });
    const before = chart.panes();
    chart.removePane(1);
    panes.reindex(before);
    expect(names()).toEqual(["price", "macd"]);
    expect(instances.get("macd")!.paneIndex).toBe(1);
    expect(macd.drawnIn).toEqual([1]);
    expect(moved).not.toHaveBeenCalled();
  });

  it("moves the price pane up when a pane above it closes", () => {
    const rsi = study(0, "rsi");
    const { panes, chart, moved } = setup(["rsi", "macd", "price"], { rsi: rsi.inst }, 2);
    const before = chart.panes();
    chart.removePane(1);
    panes.reindex(before);
    expect(panes.mainPane).toBe(1);
    expect(moved).toHaveBeenCalledTimes(1);
    expect(rsi.drawnIn).toEqual([]);
  });

  it("closes the empty panes but the price pane", () => {
    const { panes, chart, names } = setup(["price", "rsi", "gone"], {});
    chart.panes()[0].getSeries().length = 0;
    chart.panes()[2].getSeries().length = 0;
    panes.removeEmpty();
    expect(names()).toEqual(["price", "rsi"]);
  });

  it("keeps the pane the series left for a compared symbol staying there", () => {
    vi.useFakeTimers();
    // The series moved from pane 0 into the study pane below.
    const { panes, chart, names } = setup(["left", "rsi"], {}, 1);
    const left = chart.panes()[0];
    left.getSeries().length = 0;
    panes.reserve("cmp", left);
    expect(left.preserveEmptyPane()).toBe(true);
    expect(panes.unreserve("cmp")).toBe(left);
    expect(panes.unreserve("cmp")).toBeUndefined();
    // Taken in time: the pane stays.
    vi.advanceTimersByTime(3000);
    expect(names()).toEqual(["left", "rsi"]);
  });

  it("closes a kept pane nobody took, and renumbers", () => {
    vi.useFakeTimers();
    const { panes, chart, moved, names } = setup(["left", "rsi"], {}, 1);
    const left = chart.panes()[0];
    left.getSeries().length = 0;
    panes.reserve("cmp", left);
    vi.advanceTimersByTime(2999);
    expect(names()).toEqual(["left", "rsi"]);
    vi.advanceTimersByTime(1);
    expect(left.preserveEmptyPane()).toBe(false);
    expect(names()).toEqual(["rsi"]);
    expect(panes.mainPane).toBe(0);
    expect(moved).toHaveBeenCalledTimes(1);
  });

  it("tells when the series shares a study pane (merged) and when it has its own (unmerged)", () => {
    const rsi = study(1, "rsi");
    const sma = study(0, null, true);
    const { panes } = setup(["price", "rsi"], { rsi: rsi.inst, sma: sma.inst });
    expect(panes.seriesShares()).toBe(false);
    expect(panes.groupOfPane(1)).toBe("rsi");
    expect(panes.groupOfPane(0)).toBeNull();
    expect(panes.idsInPane(1)).toEqual(["rsi"]);
    // Studies drawn over the series are not in a stacked pane.
    expect(panes.idsInPane(0)).toEqual([]);
    // The series dropped into the RSI pane: it shares it, the pane's group stays the RSI's for its other studies.
    panes.mainPane = 1;
    panes.resetUsed();
    expect(panes.seriesShares()).toBe(true);
    expect(panes.groupOfPane(1)).toBeNull();
    expect(panes.claim()).toBe(0);
    // Out again into a pane of its own.
    panes.mainPane = 2;
    panes.resetUsed();
    expect(panes.seriesShares()).toBe(false);
    expect(panes.claim()).toBe(0);
    expect(panes.claim()).toBe(3);
  });
});
