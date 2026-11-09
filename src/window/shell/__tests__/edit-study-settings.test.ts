import { describe, expect, it, vi } from "vitest";
import { createRoot, createSignal } from "solid-js";
import type { PaneChart, TabChart } from "../tabs";

// The history listens to app events on `window`: an event target stands in for it.
vi.stubGlobal("window", new EventTarget());
vi.mock("../../../components/Dialogs", () => ({ showConfirm: vi.fn() }));
const { createUndoHistory } = await import("../undo-history");
const { createChartEdits } = await import("../chart-edits");
const { defaultIndicatorOptions } = await import("../../chart/indicators/indicator-options");

/** One tab with one chart holding an RSI, its settings `settings`. */
function setup(settings?: PaneChart["indicatorSettings"]) {
  const pane = { symbol: "NASDAQ:AAPL", interval: "1D", indicators: ["rsi"], indicatorSettings: settings } as unknown as PaneChart;
  const [tabs, setTabs] = createSignal<TabChart[]>([{ id: "t1", panes: [pane], activePane: 0 } as unknown as TabChart]);
  const tabOf = (id: string) => tabs().find((t) => t.id === id);
  const patchTab = (id: string, patch: Partial<TabChart>) => setTabs((all) => all.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  let edits!: ReturnType<typeof createChartEdits>;
  const undo = createUndoHistory((e, side) => edits.applyUndoEntry(e, side));
  edits = createChartEdits(
    { tabOf, patchTab, activeTab: () => tabs()[0], activePaneState: () => tabs()[0].panes[0], patchActivePane: () => {} },
    undo,
    { drawingKeyFor: () => "", drawingsFor: () => [], splitView: () => ({}) as never, restoreSlice: () => {} } as never,
  );
  const saved = () => tabOf("t1")!.panes[0].indicatorSettings?.rsi;
  return { edits, undo, saved };
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
