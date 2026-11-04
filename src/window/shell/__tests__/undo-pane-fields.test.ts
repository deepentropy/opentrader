import { describe, expect, it, vi } from "vitest";
import { createRoot } from "solid-js";
import type { UndoEntry } from "../undo-history";

// The history listens to app events on `window`: an event target stands in for it.
vi.stubGlobal("window", new EventTarget());
const { createUndoHistory } = await import("../undo-history");

describe("symbol / interval / chart type undo steps", () => {
  it("records a change already made, then undo and redo apply its sides", () =>
    createRoot((dispose) => {
      const applied: [string, string][] = [];
      const h = createUndoHistory((e, side) => {
        if (e.kind === "pane-fields") applied.push([side, String(e[side]["pane-1"]?.symbol)]);
      });
      const entry: UndoEntry = {
        kind: "pane-fields",
        tabId: "tab-1",
        before: { "pane-1": { symbol: "NASDAQ:AAPL" } },
        after: { "pane-1": { symbol: "NASDAQ:MSFT" } },
        label: "change symbol",
        at: 0,
      };
      h.record(entry);
      expect(applied).toEqual([]);
      expect(h.undoLabel()).toBe("Undo change symbol");
      h.undo();
      h.redo();
      expect(applied).toEqual([["before", "NASDAQ:AAPL"], ["after", "NASDAQ:MSFT"]]);
      dispose();
    }));
});
