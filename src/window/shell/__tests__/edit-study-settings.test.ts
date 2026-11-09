import { describe, expect, it, vi } from "vitest";
import { createRoot, createSignal } from "solid-js";
import type { Drawing } from "lightweight-charts-drawing/core/types";
import type { PaneChart, TabChart } from "../tabs";

// The history listens to app events on `window`: an event target stands in for it.
vi.stubGlobal("window", new EventTarget());
vi.mock("../../../components/Dialogs", () => ({ showConfirm: vi.fn() }));
const { createUndoHistory } = await import("../undo-history");
const { createChartEdits } = await import("../chart-edits");
const { defaultIndicatorOptions } = await import("../../chart/indicators/indicator-options");

/** One tab with one chart holding an RSI, its settings `settings` (`more`: other fields of the chart). */
function setup(settings?: PaneChart["indicatorSettings"], more: Partial<PaneChart> = {}) {
  const pane = { symbol: "NASDAQ:AAPL", interval: "1D", indicators: ["rsi"], indicatorSettings: settings, ...more } as unknown as PaneChart;
  // The drawings by key, one slice per key.
  const drawings = new Map<string, Drawing[]>();
  const [tabs, setTabs] = createSignal<TabChart[]>([{ id: "t1", panes: [pane], activePane: 0 } as unknown as TabChart]);
  const tabOf = (id: string) => tabs().find((t) => t.id === id);
  const patchTab = (id: string, patch: Partial<TabChart>) => setTabs((all) => all.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  let edits!: ReturnType<typeof createChartEdits>;
  const undo = createUndoHistory((e, side) => edits.applyUndoEntry(e, side));
  edits = createChartEdits(
    { tabOf, patchTab, activeTab: () => tabs()[0], activePaneState: () => tabs()[0].panes[0], patchActivePane: () => {} },
    undo,
    {
      drawingKeyFor: () => "",
      drawingsFor: (key: string) => drawings.get(key) ?? [],
      splitView: (key: string, list: Drawing[]) => [{ key, before: drawings.get(key) ?? [], after: list }],
      restoreSlice: (key: string, list: Drawing[]) => drawings.set(key, list),
    } as never,
  );
  const saved = () => tabOf("t1")!.panes[0].indicatorSettings?.rsi;
  return { edits, undo, saved, drawings, pane: () => tabOf("t1")!.panes[0] };
}

describe("editStudySettings", () => {
  it("writes the store as one undo step, and undo / redo put each side back", () =>
    createRoot((dispose) => {
      const { edits, undo, saved } = setup({ rsi: { inputs: { length: 14 }, hidden: true } });
      edits.editStudySettings("t1", 0, "rsi", { inputs: { length: 21 } }, "change RSI properties");
      expect(saved()).toEqual({ inputs: { length: 21 }, hidden: true });
      expect(undo.undoLabel()).toBe("Undo change RSI properties");
      undo.undo();
      expect(saved()).toEqual({ inputs: { length: 14 }, hidden: true });
      undo.redo();
      expect(saved()?.inputs).toEqual({ length: 21 });
      dispose();
    }));

  it("gives a study on its defaults default values to go back to", () =>
    createRoot((dispose) => {
      const { edits, undo, saved } = setup();
      edits.editStudySettings("t1", 0, "rsi", { inputs: { length: 21 }, options: { ...defaultIndicatorOptions(), ownPane: true } }, "x");
      undo.undo();
      expect(saved()).toEqual({ inputs: {}, options: defaultIndicatorOptions() });
      dispose();
    }));

  it("records nothing when the settings do not change, or the study is not on the chart", () =>
    createRoot((dispose) => {
      const { edits, undo } = setup({ rsi: { inputs: { length: 14 } } });
      edits.editStudySettings("t1", 0, "rsi", { inputs: { length: 14 } }, "x");
      edits.editStudySettings("t1", 0, "macd", { inputs: { fast: 3 } }, "x");
      expect(undo.canUndo()).toBe(false);
      dispose();
    }));

  it("coalesces the steps of one dialog field, and Cancel takes the session back", () =>
    createRoot((dispose) => {
      const { edits, undo, saved } = setup({ rsi: { inputs: { length: 14 } } });
      edits.editStudySettings("t1", 0, "rsi", { inputs: { length: 1 } }, "x", { coalesce: "s:length", session: "s" });
      edits.editStudySettings("t1", 0, "rsi", { inputs: { length: 15 } }, "x", { coalesce: "s:length", session: "s" });
      expect(undo.undoStack().length).toBe(1);
      undo.rollback("s");
      expect(saved()?.inputs).toEqual({ length: 14 });
      expect(undo.canUndo()).toBe(false);
      dispose();
    }));

  it("patchStudyInputs merges input values", () =>
    createRoot((dispose) => {
      const { edits, saved } = setup({ rsi: { inputs: { length: 14, src: "close" } } });
      edits.patchStudyInputs("t1", 0, "rsi", { length: 9 });
      expect(saved()?.inputs).toEqual({ length: 9, src: "close" });
      dispose();
    }));
});

describe("editSources", () => {
  it("writes a study, the pane order and the series' scale as one undo step", () =>
    createRoot((dispose) => {
      const { edits, undo, saved, pane } = setup({ rsi: { inputs: { length: 14 } } });
      const options = { ...defaultIndicatorOptions(), scale: "left" as const };
      edits.editSources("t1", 0, { studies: { rsi: { options } }, paneOrder: ["rsi", "_series"], seriesScale: "left" }, "pin to left scale");
      expect(undo.undoStack().length).toBe(1);
      expect(saved()?.options).toEqual(options);
      expect(pane().paneOrder).toEqual(["rsi", "_series"]);
      expect(pane().seriesScale).toBe("left");
      undo.undo();
      expect(saved()).toEqual({ inputs: { length: 14 }, options: defaultIndicatorOptions() });
      expect(pane().paneOrder).toBeUndefined();
      expect(pane().seriesScale).toBeUndefined();
      dispose();
    }));

  it("writes a pane swap with the studies' list in the new order, the series' pane and the sources' order", () =>
    createRoot((dispose) => {
      const { edits, undo, pane } = setup(undefined, { indicators: ["rsi", "macd"], paneOrder: ["_series", "rsi", "macd"], seriesPane: "rsi" });
      edits.editSources("t1", 0, { indicators: ["macd", "rsi"], paneOrder: ["_series", "macd", "rsi"], seriesPane: null, sourceOrder: ["macd", "_series"] }, "move pane up");
      expect(undo.undoLabel()).toBe("Undo move pane up");
      expect(pane().indicators).toEqual(["macd", "rsi"]);
      expect(pane().paneOrder).toEqual(["_series", "macd", "rsi"]);
      expect(pane().seriesPane).toBeUndefined();
      expect(pane().sourceOrder).toEqual(["macd", "_series"]);
      undo.undo();
      expect(pane().indicators).toEqual(["rsi", "macd"]);
      expect(pane().paneOrder).toEqual(["_series", "rsi", "macd"]);
      expect(pane().seriesPane).toBe("rsi");
      expect(pane().sourceOrder).toBeUndefined();
      dispose();
    }));

  it("places the drawings in the same step, even when the sources do not change", () =>
    createRoot((dispose) => {
      const { edits, undo, drawings } = setup();
      const a = { id: "a" } as Drawing;
      const b = { id: "b", over: "rsi" } as unknown as Drawing;
      drawings.set("view", [a, b]);
      edits.editSources("t1", 0, { drawings: { key: "view", list: [b, a] } }, "bring RSI to front");
      expect(undo.undoStack().length).toBe(1);
      expect(drawings.get("view")).toEqual([b, a]);
      undo.undo();
      expect(drawings.get("view")).toEqual([a, b]);
      dispose();
    }));

  it("keeps two writes of one move with the same key as one step", () =>
    createRoot((dispose) => {
      const { edits, undo, saved, pane } = setup({ rsi: { inputs: { length: 14 } } });
      const options = { ...defaultIndicatorOptions(), paneGroup: "macd" };
      edits.editSources("t1", 0, { studies: { rsi: { options } }, paneOrder: ["macd"] }, "merge to pane", { coalesce: "move-1" });
      edits.editSources("t1", 0, { sourceOrder: ["rsi", "_series"] }, "merge to pane", { coalesce: "move-1" });
      edits.editSources("t1", 0, { sourceOrder: ["_series", "rsi"] }, "insert RSI before AAPL", { coalesce: "move-2" });
      expect(undo.undoStack().length).toBe(2);
      undo.undo();
      expect(pane().sourceOrder).toEqual(["rsi", "_series"]);
      undo.undo();
      expect(saved()?.options).toEqual(defaultIndicatorOptions());
      expect(pane().paneOrder).toBeUndefined();
      expect(pane().sourceOrder).toBeUndefined();
      dispose();
    }));
});
