/*
 * The edits a chart makes to its pane and its drawings, bound to the tab and
 * pane it shows: the stores' functions (chart-edits.ts, drawing-store.ts) with
 * the chart's tab id, pane index and drawings key. A chart of a hidden tab
 * makes no edits (every opened tab keeps its grid mounted); the view state it
 * reports (visible range, eyes, link group) and the reads still go through.
 */
import type { Drawing, NewDrawing } from "lightweight-charts-drawing/core/types";
import type { ChartEdits, SourcesPatch } from "../../shell/chart-edits";
import type { DrawingStore } from "../../drawings/drawing-store";
import type { ComparePatch, PaneChart, PaneIndicatorSettings } from "../../shell/tabs";
import type { SyncMode } from "../../drawings/DrawingToolbar";

/** Where a chart's edits go. */
export type PaneEditsTarget = {
  chartEdits: ChartEdits;
  drawingStore: DrawingStore;
  tabId: string;
  paneIndex: number;
  /** Key the pane's drawings are kept under (its sync scope). */
  drawingKey: string;
  /** False while the chart's tab is hidden. */
  shown?: boolean;
  /** Focus this chart (acting on its drawings focuses it). */
  onFocus?: () => void;
};

export function createPaneEdits(t: PaneEditsTarget) {
  const live = () => t.shown !== false;
  return {
    // ── Sources ────────────────────────────────────────────────────────
    removeIndicator: (id: string) => live() && t.chartEdits.removeIndicatorFromPane(t.tabId, t.paneIndex, id),
    /** Persist a study's settings (no undo step: the eye, a scale given to a new request). */
    setIndicatorSettings: (id: string, s: PaneIndicatorSettings) => live() && t.chartEdits.setIndicatorSettingsForPane(t.tabId, t.paneIndex, id, s),
    editStudySettings: (id: string, patch: PaneIndicatorSettings, label: string, opts?: { coalesce?: string; session?: string }) =>
      live() && t.chartEdits.editStudySettings(t.tabId, t.paneIndex, id, patch, label, opts),
    editSources: (patch: SourcesPatch, label: string, opts?: { coalesce?: string }) =>
      live() && t.chartEdits.editSources(t.tabId, t.paneIndex, patch, label, opts),
    /** A Settings dialog's Cancel: the steps of its session taken back. */
    rollbackSources: (session: string) => t.chartEdits.rollbackSources(session),
    patchCompare: (id: string, patch: ComparePatch) => live() && t.chartEdits.patchCompare(t.tabId, t.paneIndex, id, patch),
    removeCompare: (id: string) => live() && t.chartEdits.removeCompare(t.tabId, t.paneIndex, id),
    setSeriesPane: (group: string | null) => live() && t.chartEdits.setSeriesPaneForPane(t.tabId, t.paneIndex, group),
    // ── View state of the chart ─────────────────────────────────────────
    setVisibleRange: (r: Parameters<ChartEdits["setVisibleRangeForPane"]>[2]) => t.chartEdits.setVisibleRangeForPane(t.tabId, t.paneIndex, r),
    toggleSeriesHidden: () => t.chartEdits.toggleSeriesHidden(t.tabId, t.paneIndex),
    toggleIndicatorsLegend: () => t.chartEdits.toggleIndicatorsLegend(t.tabId, t.paneIndex),
    setLinkGroup: (g: PaneChart["linkGroup"]) => t.chartEdits.setPaneLinkGroup(t.tabId, t.paneIndex, g),
    // ── Drawings ───────────────────────────────────────────────────────
    placeDrawing: (d: NewDrawing): string | void => {
      if (!live()) return;
      t.onFocus?.();
      return t.drawingStore.addDrawingToSymbol(t.drawingKey, d);
    },
    updateDrawing: (d: Drawing, label?: string) => live() && t.drawingStore.updateDrawingForSymbol(t.drawingKey, d, label),
    /** Bulk replace (group drag / nudge): one undo entry. */
    updateDrawings: (list: Drawing[]) => live() && t.drawingStore.updateDrawingsForSymbol(t.drawingKey, list),
    cloneDrawing: (id: string | string[]) => live() && t.drawingStore.cloneDrawingForSymbol(t.drawingKey, id),
    /** Sync of a drawing (the scope it is kept in). */
    drawingSync: (id: string): SyncMode | null => t.drawingStore.drawingSyncForSymbol(t.drawingKey, id),
    setDrawingSync: (ids: string[], mode: SyncMode) => live() && t.drawingStore.setDrawingsSyncForSymbol(t.drawingKey, ids, mode),
    reorderDrawing: (id: string, dir: "front" | "forward" | "backward" | "back") => live() && t.drawingStore.reorderDrawingForSymbol(t.drawingKey, id, dir),
    /** The Object tree moved drawings: the pane's drawings in their new order (front first) and the source each one
     *  sits in front of. */
    placeDrawings: (ids: string[], over: Record<string, string | null>) => live() && t.drawingStore.placeDrawingsForSymbol(t.drawingKey, ids, over),
    /** The pane's drawings placed so (see placeDrawings), for a source's move to save with it (editSources); null
     *  when none moves. */
    placedDrawings: (ids: string[], over: Record<string, string | null>): { key: string; list: Drawing[] } | null => {
      const list = t.drawingStore.placedDrawings(t.drawingKey, ids, over);
      return list ? { key: t.drawingKey, list } : null;
    },
    removeDrawing: (id: string) => live() && t.drawingStore.removeDrawingForSymbol(t.drawingKey, id),
    /** Bulk delete (multi-select Delete): one undo entry. */
    removeDrawings: (ids: string[]) => live() && t.drawingStore.removeDrawingsForSymbol(t.drawingKey, ids),
  };
}

export type PaneEdits = ReturnType<typeof createPaneEdits>;
