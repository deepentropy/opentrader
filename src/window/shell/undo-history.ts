/*
 * Undo / redo history of the window (header Undo/Redo + Ctrl+Z / Ctrl+Y):
 * drawing changes, studies removed with the drawings they own, compared
 * symbols added / removed and layout splitter sizes. Session-scoped, not
 * persisted with the layout. Every drawing mutation that flows through the
 * drawing store's setSlice records {key, before, after}; drag streams
 * (updateDrawing per pointer-move) coalesce into ONE entry via coalesceId + a
 * sliding 800ms window, so one gesture = one undo step. Applying an entry is
 * the caller's (`apply`, wired by App to the chart edits). Created once by App.
 */
import { createSignal, onCleanup } from "solid-js";
import type { Drawing } from "lightweight-charts-drawing/core/types";
import { onAppEvent } from "../../data/app-events";
import type { CompareEntry, PaneChart } from "./tabs";
import type { LayoutId } from "../chart/layouts";
import type { Sizing } from "../chart/layout-sizes";

export type DrawingSlice = { key: string; before: Drawing[]; after: Drawing[] };

export type DrawingUndoEntry = {
  kind?: undefined;
  key: string;
  before: Drawing[];
  after: Drawing[];
  /** A view key's change: the scope slices it touched. */
  slices?: DrawingSlice[];
  label: string;
  at: number;
  coalesceId?: string;
};
/** Studies removed from a chart, with the drawings they owned (removed with
 *  them): one undo step brings both back, settings included. Only these
 *  studies are put back / removed again (a study added since is kept). */
export type StudyUndoEntry = {
  kind: "study";
  tabId: string;
  paneIndex: number;
  /** Removed study ids and their index in the list before the removal. */
  ids: string[];
  positions: number[];
  settings: NonNullable<PaneChart["indicatorSettings"]>;
  slices: DrawingSlice[];
  label: string;
  at: number;
};
/** Compared symbols added / removed: the pane's compare list before and
 *  after. */
export type CompareUndoEntry = {
  kind: "compare";
  tabId: string;
  paneIndex: number;
  before: CompareEntry[] | undefined;
  after: CompareEntry[] | undefined;
  label: string;
  at: number;
};
/** Chart sizes of a layout template changed with a splitter (drag, or a
 *  double click = back to equal sizes). */
export type LayoutSizesUndoEntry = {
  kind: "layout-sizes";
  tabId: string;
  layout: LayoutId;
  before: Sizing | undefined;
  after: Sizing | undefined;
  label: string;
  at: number;
};
/** The sources of a chart (studies, their settings, compared symbols and
 *  the orders), as one layout-wide edit saves them. */
export type ChartSources = Pick<PaneChart, "indicators" | "indicatorSettings" | "compare" | "paneOrder" | "sourceOrder" | "seriesScale" | "seriesPane">;
/** Sources of several charts of a layout changed together (a study / symbol
 *  added to the entire layout, the indicators applied to the entire layout,
 *  a source pasted): each chart's sources before and after, by chart index,
 *  and the drawings removed with the studies they belonged to. */
export type LayoutSourcesUndoEntry = {
  kind: "layout-sources";
  tabId: string;
  before: Record<number, ChartSources>;
  after: Record<number, ChartSources>;
  slices: DrawingSlice[];
  label: string;
  at: number;
};
/** Two charts of a layout swapped their places (chart menu "Move chart");
 *  the focused chart before and after. Swapping again undoes it. */
export type ChartSwapUndoEntry = {
  kind: "chart-swap";
  tabId: string;
  a: number;
  b: number;
  activeBefore: number;
  activeAfter: number;
  label: string;
  at: number;
};
export type UndoEntry = DrawingUndoEntry | StudyUndoEntry | CompareUndoEntry | LayoutSizesUndoEntry | LayoutSourcesUndoEntry | ChartSwapUndoEntry;

const UNDO_CAP = 100;

/** `apply(entry, side)` writes one side of an entry. */
export function createUndoHistory(apply: (e: UndoEntry, side: "before" | "after") => void) {
  const [undoStack, setUndoStack] = createSignal<UndoEntry[]>([]);
  const [redoStack, setRedoStack] = createSignal<UndoEntry[]>([]);
  const canUndo = () => undoStack().length > 0;
  const canRedo = () => redoStack().length > 0;
  const undoLabel = () => {
    const e = undoStack()[undoStack().length - 1];
    return e ? `Undo ${e.label}` : "Undo";
  };
  const redoLabel = () => {
    const e = redoStack()[redoStack().length - 1];
    return e ? `Redo ${e.label}` : "Redo";
  };
  // Bumped by the overlay's pointer-up ("drawing-gesture-end") so two quick
  // drags of the same drawing never coalesce into one undo entry — the time
  // window alone merged back-to-back gestures.
  let gestureEpoch = 0;
  let lastEntryEpoch = -1;
  onCleanup(onAppEvent("drawing-gesture-end", () => { gestureEpoch++; }));
  function recordDrawingChange(
    key: string,
    before: Drawing[],
    after: Drawing[],
    meta: { label: string; coalesceId?: string },
    slices?: DrawingSlice[],
  ) {
    const stack = undoStack();
    const last = stack[stack.length - 1];
    if (
      meta.coalesceId &&
      last &&
      !last.kind &&
      last.coalesceId === meta.coalesceId &&
      last.key === key &&
      lastEntryEpoch === gestureEpoch &&
      Date.now() - last.at < 800
    ) {
      // Same gesture continuing — extend the open entry (keep its `before`).
      let merged = last.slices;
      if (slices) {
        merged = [...(last.slices ?? [])];
        for (const s of slices) {
          const i = merged.findIndex((m) => m.key === s.key);
          if (i >= 0) merged[i] = { ...merged[i], after: s.after };
          else merged.push(s);
        }
      }
      setUndoStack([...stack.slice(0, -1), { ...last, after, slices: merged, at: Date.now() }]);
    } else {
      setUndoStack([
        ...stack.slice(Math.max(0, stack.length - (UNDO_CAP - 1))),
        { key, before, after, slices, label: meta.label, at: Date.now(), coalesceId: meta.coalesceId },
      ]);
    }
    lastEntryEpoch = gestureEpoch;
    if (redoStack().length) setRedoStack([]);
  }
  /** Apply a new (non-drawing) entry and record it as one undo step. */
  function commit(entry: UndoEntry) {
    apply(entry, "after");
    const stack = undoStack();
    setUndoStack([...stack.slice(Math.max(0, stack.length - (UNDO_CAP - 1))), entry]);
    if (redoStack().length) setRedoStack([]);
  }
  function undo() {
    const stack = undoStack();
    const e = stack[stack.length - 1];
    if (!e) return;
    setUndoStack(stack.slice(0, -1));
    setRedoStack([...redoStack(), e]);
    apply(e, "before");
  }
  function redo() {
    const stack = redoStack();
    const e = stack[stack.length - 1];
    if (!e) return;
    setRedoStack(stack.slice(0, -1));
    setUndoStack([...undoStack(), e]);
    apply(e, "after");
  }

  return { undoStack, redoStack, canUndo, canRedo, undoLabel, redoLabel, recordDrawingChange, commit, undo, redo };
}

export type UndoHistory = ReturnType<typeof createUndoHistory>;
