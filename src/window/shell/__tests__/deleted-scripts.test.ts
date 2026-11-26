import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, createSignal } from "solid-js";
import type { Drawing } from "lightweight-charts-drawing/core/types";
import type { PaneChart, TabChart } from "../tabs";

vi.stubGlobal("window", new EventTarget());
const stored = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => stored.get(k) ?? null,
  setItem: (k: string, v: string) => void stored.set(k, v),
  removeItem: (k: string) => void stored.delete(k),
  key: (i: number) => [...stored.keys()][i] ?? null,
  get length() { return stored.size; },
});
vi.mock("../../../components/Dialogs", () => ({ showConfirm: vi.fn() }));
const { createUndoHistory } = await import("../undo-history");
const { createChartEdits } = await import("../chart-edits");
const { chartsShowingScript, reviveStudies } = await import("../tabs");
const { createScript, deleteScript, onScriptDeleted } = await import("../../../data/oakscript-store");

const chart = (indicators: string[], settings?: PaneChart["indicatorSettings"]) =>
  ({ symbol: "NASDAQ:AAPL", interval: "1D", indicators, indicatorSettings: settings }) as unknown as PaneChart;

function setup(all: PaneChart[][], drawn: Drawing[] = []) {
  const drawings = new Map<string, Drawing[]>([["t1/0", drawn]]);
  const [tabs, setTabs] = createSignal<TabChart[]>(all.map((panes, i) => ({ id: `t${i + 1}`, panes, activePane: 0 }) as unknown as TabChart));
  const tabOf = (id: string) => tabs().find((t) => t.id === id);
  const patchTab = (id: string, patch: Partial<TabChart>) => setTabs((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  let edits!: ReturnType<typeof createChartEdits>;
  const undo = createUndoHistory((e, side) => edits.applyUndoEntry(e, side));
  edits = createChartEdits(
    { tabs, tabOf, patchTab, activeTab: () => tabs()[0], activePaneState: () => tabs()[0].panes[0], patchActivePane: () => {} },
    undo,
    {
      drawingKeyFor: (p: PaneChart, tab: string) => `${tab}/${tabOf(tab)!.panes.indexOf(p)}`,
      drawingsFor: (key: string) => drawings.get(key) ?? [],
      splitView: (key: string, list: Drawing[]) => [{ key, before: drawings.get(key) ?? [], after: list }],
      restoreSlice: (key: string, list: Drawing[]) => void drawings.set(key, list),
    } as never,
  );
  const studies = () => tabs().map((t) => t.panes.map((p) => p.indicators));
  return { edits, undo, studies, drawings };
}

describe("a deleted script", () => {
  beforeEach(() => stored.clear());

  it("leaves every chart, with the studies built on it and the drawings they own", () =>
    createRoot((dispose) => {
      const { edits, studies, drawings } = setup(
        [
          [chart(["volume", "user:a", "user:a#2", "sma"], { sma: { inputs: { src: "user:a#2$0" } } }), chart(["strategy:user:a", "user:b"])],
          [chart(["user:a"])],
        ],
        [{ id: "1", owner: "user:a" }, { id: "2", owner: "volume" }, { id: "3" }] as unknown as Drawing[],
      );
      edits.removeScript("a");
      expect(studies()).toEqual([[["volume"], ["user:b"]], [[]]]);
      expect(drawings.get("t1/0")!.map((x) => x.id)).toEqual(["2", "3"]);
      dispose();
    }));

  it("is not brought back by undo or redo; the other steps stay", () =>
    createRoot((dispose) => {
      const { edits, undo, studies } = setup([[chart(["volume", "user:a", "rsi"])]]);
      edits.removeIndicatorFromPane("t1", 0, "user:a");
      edits.removeIndicatorFromPane("t1", 0, "rsi");
      edits.addStudyTo("t1", "user:a");
      undo.undo();
      edits.removeScript("a");
      expect(undo.undoStack().length).toBe(1);
      expect(undo.redoStack().length).toBe(0);
      undo.undo();
      expect(studies()).toEqual([[["volume", "rsi"]]]);
      dispose();
    }));

  it("is taken out of a step that holds other studies", () =>
    createRoot((dispose) => {
      const { edits, undo, studies } = setup([[chart(["volume", "user:a", "rsi"])]]);
      edits.removeAllIndicators();
      edits.removeScript("a");
      undo.undo();
      expect(studies()).toEqual([[["volume", "rsi"]]]);
      dispose();
    }));

  it("is dropped from the charts read back, a plugin's script is kept", () => {
    const { id } = createScript("Mine");
    const p = chart([`user:${id}`, "plugin-less", "user:plugin:algo:x", "sma"], { sma: { inputs: { src: `user:${id}$0` } }, rsi: {} } as never);
    expect(reviveStudies(p).indicators).toEqual(p.indicators);
    deleteScript(id);
    expect(reviveStudies(p).indicators).toEqual(["plugin-less", "user:plugin:algo:x"]);
    expect(reviveStudies(p).indicatorSettings).toEqual({ rsi: {} });
  });

  it("is told to the listeners, and counted on the charts of every window", () => {
    const { id } = createScript("Mine");
    stored.set("ot:tabs:main", JSON.stringify([{ panes: [chart([`user:${id}`, `user:${id}#2`]), chart(["rsi"])] }]));
    stored.set("ot:tabs:w2", JSON.stringify([{ panes: [chart([`strategy:user:${id}`])] }]));
    expect(chartsShowingScript(id)).toBe(2);
    const seen: string[] = [];
    const off = onScriptDeleted((x) => seen.push(x));
    deleteScript(id);
    off();
    expect(seen).toEqual([id]);
  });
});
