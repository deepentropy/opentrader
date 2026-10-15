/*
 * App events: the window-wide messages between the shell, the charts and the
 * panels, with their payload types in one place.
 *
 * They ride on window CustomEvents under the same names as before, so a
 * listener on `window` (the tab link relay, the debug-port test scripts) still
 * sees them. A request answered synchronously ("chart-goto-query") works as
 * dispatch is synchronous: the receiver fills the payload in place.
 */
import type { WallDate, WallTime } from "../window/chart/day-key";
import type { GotoQuery } from "../window/chart/goto-query";
import type { ScaleMenuPatch } from "../window/header/chart-settings";
import type { DialogTab } from "../window/chart/IndicatorSettingsDialog";
import type { DrawingKind } from "lightweight-charts-drawing/core/types";
import type { SessionId } from "./datafeed";
import type { ClipboardSource } from "../window/drawings/clipboard";

/** Payload of "chart-open-alert-dialog": a rule to edit, or the source and
 *  price of a new one. */
export type OpenAlertDialogDetail = {
  editId?: string;
  symbol?: string;
  price?: number;
  indicatorId?: string;
  /** New alert on a compared symbol of the chart (its full name): the source. */
  compareSymbol?: string;
  drawingId?: string;
};

/** Payload of "chart-add-to-layout": the source and where it sits on its
 *  chart (study / compared-symbol menu "Add this … to entire layout"). */
export type AddToLayoutDetail = {
  source: ClipboardSource;
  place: { main: boolean; paneIndex?: number; asCompare?: boolean };
};

/** Payload of "drawing-place-at-cursor": the toolbar asks the pane under the
 *  pointer to place a drawing there; the pane that does sets `handled`. */
export type PlaceAtCursorDetail = { kind: DrawingKind; handled: boolean };

/** Every app event and its payload (`undefined` = no payload). */
export interface AppEvents {
  // ── Data ──────────────────────────────────────────────────────────────
  /** Every chart refetches its bars (ADJ toggle, data basis change). */
  "chart-reload-data": undefined;
  /** The dividend adjustment flag changed (bottom bar ADJ button). */
  "adjusted-changed": undefined;

  // ── Shell requests from a chart or a panel ───────────────────────────
  "chart-open-settings": { tab?: string } | undefined;
  "chart-save-template": undefined;
  "chart-apply-template": { name: string };
  "chart-remove-template": { name: string };
  "chart-clear-indicators": undefined;
  "chart-open-panel": { id: string };
  "chart-open-alert-dialog": OpenAlertDialogDetail | undefined;
  "chart-patch-scale-settings": { patch: ScaleMenuPatch };
  "chart-set-session": { id: SessionId };
  "chart-set-timezone": { label: string };
  "chart-open-indicators": undefined;
  /** Main series / compared symbol menu "Symbol info…": the dialog on that symbol. */
  "chart-open-symbol-info": { symbol: string };
  /** Study / compared-symbol menu "Add this … to entire layout" (the
   *  focused chart's source to every other chart of the layout). */
  "chart-add-to-layout": AddToLayoutDetail;
  /** Chart menu "Apply these indicators to entire layout". */
  "chart-apply-studies-to-layout": undefined;
  /** Chart menu "Paste" / Ctrl+V of a copied study or compared symbol. */
  "chart-paste-source": undefined;
  /** One edit of a source of the focused chart (visual order, visibility on intervals, Move to, Pin to scale,
   *  settings): begin / end around it, one undo step named `label` (source-edits.ts). */
  "chart-sources-edit": { phase: "begin" | "end"; label: string };
  /** Chart menu "Move chart" > Forward / Back (the focused chart). */
  "chart-move-in-layout": { back: boolean };

  // ── Requests to the active chart ─────────────────────────────────────
  "chart-open-study-settings": { id: string; tab?: DialogTab };
  "chart-patch-study-inputs": { id: string; patch: Record<string, unknown> };
  "chart-zoom": { dir: "in" | "out" };
  "chart-scale": { mode: "invert" | "log" | "percent" };
  "chart-snapshot": { action?: "copy" | "download" | "open" };
  "chart-reset": undefined;
  "chart-reset-time": undefined;
  "chart-goto-realtime": undefined;
  "chart-goto-first": undefined;
  "chart-scroll-start": { dir: -1 | 1; mode: "bar" | "smooth" };
  "chart-scroll-stop": undefined;
  /** Bottom-bar date-range tab ("1D" … "All"). */
  "chart-set-range": { span: string };
  /** Go to dialog, Date tab (wall-clock date in the chart time zone). */
  "chart-goto-date": { date: WallDate; minutes: number };
  /** Go to dialog, Custom range tab. */
  "chart-goto-range": { from: WallTime; to: WallTime };
  /** Go to dialog opening: the active chart fills the query in place. */
  "chart-goto-query": GotoQuery;

  // ── Sync between the charts of a layout, and linked tabs ─────────────
  "chart-sync-crosshair": { time: number | null; price?: number | null; sourceId: number; relayed?: boolean };
  "chart-sync-range": { from: number; to: number; sourceId: number };
  "chart-sync-time": { time: number; sourceId: number };
  "chart-link-range": { from: number; to: number };
  "chart-link-time": { time: number };

  // ── Studies and the Object tree ──────────────────────────────────────
  "strategy-report-updated": { chartId: string; key: string };
  "oakscript-script-updated": { scriptId: string; structural: boolean };
  "oakscript-open-script": { scriptId: string };
  "chart-tree-toggle-hide": { id: string };
  "chart-tree-remove": { id: string };
  "chart-tree-move": { id: string; target: string; below: boolean };
  "chart-select-study": { id: string };
  "chart-move-study": { id: string; where: "above" | "below" };

  // ── Drawings ─────────────────────────────────────────────────────────
  "select-drawing-tool": { toolId: string };
  "drawing-gesture-end": undefined;
  "drawing-nudge": { dx: number; dy: number };
  "drawing-place-at-cursor": PlaceAtCursorDetail;

  // ── Watchlist ────────────────────────────────────────────────────────
  "watchlist-navigate": { dir: number };
  "wl-open-note": undefined;
}

export type AppEventName = keyof AppEvents;

type EmitArgs<K extends AppEventName> = undefined extends AppEvents[K]
  ? [detail?: AppEvents[K]]
  : [detail: AppEvents[K]];

/** Send an app event (synchronous: every listener has run on return). */
export function emitAppEvent<K extends AppEventName>(type: K, ...args: EmitArgs<K>): void {
  const detail = args[0];
  window.dispatchEvent(new CustomEvent(type, detail === undefined ? undefined : { detail }));
}

/** Listen to an app event; returns the unsubscribe function (hand it to
 *  `onCleanup` in a component). A payload-less event gives `undefined`. */
export function onAppEvent<K extends AppEventName>(
  type: K,
  fn: (detail: AppEvents[K]) => void,
  options?: AddEventListenerOptions,
): () => void {
  const handler = (e: Event) => fn(((e as CustomEvent).detail ?? undefined) as AppEvents[K]);
  window.addEventListener(type, handler, options);
  return () => window.removeEventListener(type, handler, options);
}
