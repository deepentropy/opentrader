import { describe, expect, it, vi } from "vitest";
import { createRoot } from "solid-js";
import type { UndoEntry } from "../undo-history";

// The history listens to app events on `window`: an event target stands in for it.
vi.stubGlobal("window", new EventTarget());
const { createUndoHistory } = await import("../undo-history");

const step = (n: number, coalesce: string, session = "s1"): UndoEntry => ({
  kind: "layout-sources",
  tabId: "tab-1",
  before: { 0: { indicators: ["rsi"], indicatorSettings: { rsi: { inputs: { length: n - 1 } } } } },
  after: { 0: { indicators: ["rsi"], indicatorSettings: { rsi: { inputs: { length: n } } } } },
  slices: [],
  label: "change Length property",
  at: n,
  coalesce,
  session,
});

describe("Settings dialog undo steps", () => {
  it("merges the keystrokes of one field, keeps another field as its own step", () =>
    createRoot((dispose) => {
      const h = createUndoHistory(() => {});
      h.commit(step(15, "s1:input:length"));
      h.commit(step(16, "s1:input:length"));
      h.commit(step(17, "s1:input:src"));
      expect(h.undoStack().length).toBe(2);
      const first = h.undoStack()[0] as Extract<UndoEntry, { kind: "layout-sources" }>;
      expect(first.before[0].indicatorSettings?.rsi?.inputs).toEqual({ length: 14 });
      expect(first.after[0].indicatorSettings?.rsi?.inputs).toEqual({ length: 16 });
      dispose();
    }));
  it("Cancel takes back the session's steps and leaves nothing to redo", () =>
    createRoot((dispose) => {
      const applied: string[] = [];
      const h = createUndoHistory((e, side) => applied.push(`${e.at}:${side}`));
      h.commit(step(30, "other", "s0"));
      h.commit(step(15, "s1:input:length"));
      h.commit(step(21, "s1:input:src"));
      applied.length = 0;
      h.rollback("s1");
      expect(applied).toEqual(["21:before", "15:before"]);
      expect(h.undoStack().length).toBe(1);
      expect(h.canRedo()).toBe(false);
      dispose();
    }));
});
