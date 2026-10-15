import { describe, expect, it } from "vitest";
import { MAIN_PANE_GROUP } from "../../chart/indicators/indicator-options";
import { readingOrder, stackedPanes, swapTarget, withSource } from "../layout-sources";
import type { ClipboardSource } from "../../drawings/clipboard";
import type { CompareEntry } from "../tabs";
import type { ChartSources } from "../undo-history";

// Overlay types of the tests: moving averages; the others get a pane.
const overlay = (typeId: string) => typeId === "sma" || typeId === "ema";

const chart = (p: Partial<ChartSources>): ChartSources => ({ indicators: [], ...p });

const compare = (id: string, placement: CompareEntry["placement"]): CompareEntry =>
  ({ id, symbol: "NASDAQ:MSFT", placement, color: "#3179F5", style: {} as CompareEntry["style"] });

describe("stackedPanes", () => {
  it("lists the panes under the price pane, studies then compared symbols, one id per pane", () => {
    const p = chart({
      indicators: ["sma", "rsi", "macd", "cci"],
      indicatorSettings: { cci: { options: { paneGroup: "rsi" } as never } },
      compare: [compare("c1", "pane"), compare("c2", "percent")],
    });
    expect(stackedPanes(p, overlay)).toEqual(["rsi", "macd", "c1"]);
  });

  it("follows the saved stacking order, and studies moved to / out of the price pane", () => {
    const p = chart({
      indicators: ["sma", "rsi", "macd", "ema"],
      indicatorSettings: {
        macd: { options: { paneGroup: MAIN_PANE_GROUP } as never },
        ema: { options: { ownPane: true } as never },
      },
      paneOrder: ["ema", "rsi"],
    });
    expect(stackedPanes(p, overlay)).toEqual(["ema", "rsi"]);
  });
});

describe("withSource", () => {
  const rsi: ClipboardSource = { kind: "study", typeId: "rsi", title: "RSI", settings: { inputs: { length: 21 }, options: { ownPane: false, paneGroup: "x" } as never } };
  const sma: ClipboardSource = { kind: "study", typeId: "sma", title: "SMA", settings: { inputs: { length: 50 } } };

  it("adds a study in a new pane at the source's position, or the last one", () => {
    const p = chart({ indicators: ["macd", "cci"] });
    const at1 = withSource(p, rsi, { main: false, paneIndex: 1 }, overlay);
    expect(at1.indicators).toEqual(["macd", "cci", "rsi"]);
    expect(at1.paneOrder).toEqual(["rsi", "macd", "cci"]);
    expect(at1.indicatorSettings?.rsi?.inputs).toEqual({ length: 21 });
    expect(at1.indicatorSettings?.rsi?.options?.paneGroup).toBeUndefined();
    const at9 = withSource(p, rsi, { main: false, paneIndex: 9 }, overlay);
    expect(at9.paneOrder).toEqual(["macd", "cci", "rsi"]);
  });

  it("takes a new instance id when the type is on the chart (or held by undo)", () => {
    const p = chart({ indicators: ["rsi"] });
    expect(withSource(p, rsi, { main: false, paneIndex: 1 }, overlay).indicators).toEqual(["rsi", "rsi#2"]);
    expect(withSource(p, rsi, { main: false, paneIndex: 1 }, overlay, ["rsi#2"]).indicators).toEqual(["rsi", "rsi#3"]);
  });

  it("keeps a study of the price pane there: an overlay as is, another study merged into it", () => {
    const main = withSource(chart({}), sma, { main: true, paneIndex: 0 }, overlay);
    expect(main.indicatorSettings?.sma?.options?.paneGroup).toBeUndefined();
    expect(main.indicatorSettings?.sma?.options?.ownPane).toBe(false);
    expect(main.paneOrder).toBeUndefined();
    const merged = withSource(chart({}), rsi, { main: true, paneIndex: 0 }, overlay);
    expect(merged.indicatorSettings?.rsi?.options?.paneGroup).toBe(MAIN_PANE_GROUP);
  });

  it("gives an overlay study from a pane its own pane", () => {
    const out = withSource(chart({}), sma, { main: false, paneIndex: 1 }, overlay);
    expect(out.indicatorSettings?.sma?.options?.ownPane).toBe(true);
    expect(out.paneOrder).toEqual(["sma"]);
  });

  it("a pasted study is placed by its own rules", () => {
    const out = withSource(chart({ indicators: ["macd"] }), rsi, null, overlay);
    expect(out.indicators).toEqual(["macd", "rsi"]);
    expect(out.indicatorSettings?.rsi?.options?.paneGroup).toBeUndefined();
    expect(out.paneOrder).toBeUndefined(); // a new pane goes to the bottom
  });

  it("adds a compared symbol: same % scale kept, a pane copy at the position", () => {
    const src: ClipboardSource = { kind: "compare", title: "Microsoft Corp.", entry: compare("c1", "percent") };
    const pct = withSource(chart({}), src, { main: true, paneIndex: 0, asCompare: true }, overlay);
    expect(pct.compare?.length).toBe(1);
    expect(pct.compare?.[0].placement).toBe("percent");
    expect(pct.compare?.[0].id).not.toBe("c1");
    const scale: ClipboardSource = { kind: "compare", title: "Microsoft Corp.", entry: compare("c2", "scale") };
    expect(withSource(chart({}), scale, { main: true, paneIndex: 0 }, overlay).compare?.[0].placement).toBe("scale");
    const pane: ClipboardSource = { kind: "compare", title: "Microsoft Corp.", entry: compare("c3", "pane") };
    const out = withSource(chart({ indicators: ["rsi"] }), pane, { main: false, paneIndex: 1 }, overlay);
    expect(out.compare?.[0].placement).toBe("pane");
    expect(out.paneOrder).toEqual([out.compare![0].id, "rsi"]);
  });

  it("does not change the chart it is given", () => {
    const p = chart({ indicators: ["macd"], indicatorSettings: {} });
    withSource(p, rsi, { main: false, paneIndex: 1 }, overlay);
    expect(p).toEqual({ indicators: ["macd"], indicatorSettings: {} });
  });
});

describe("Move chart", () => {
  it("orders the charts in reading order of the template", () => {
    expect(readingOrder("3h", 3)).toEqual([0, 1, 2]);
    expect(readingOrder("2v", 2)).toEqual([0, 1]);
    expect(readingOrder("4", 4)).toEqual([0, 2, 1, 3]); // numbered by column
  });

  it("swaps with the next chart (Forward) or the previous one (Back), wrapping", () => {
    expect(swapTarget("3h", 3, 1, false)).toBe(2);
    expect(swapTarget("3h", 3, 2, false)).toBe(0);
    expect(swapTarget("3h", 3, 0, true)).toBe(2);
    expect(swapTarget("3h", 3, 1, true)).toBe(0);
    expect(swapTarget("s", 1, 0, false)).toBeNull();
  });
});
