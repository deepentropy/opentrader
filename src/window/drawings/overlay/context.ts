/*
 * Shared context of the drawings overlay's parts (overlay/*.ts). The overlay
 * component owns the pointer state (placement points, cursor, drag, size,
 * held modifiers); each part is created with this context and adds its own
 * functions to it (attach), so the parts reach each other through it without
 * a creation order. The mutable fields are live accessors of the overlay's
 * state.
 */
import type { Accessor, Setter } from "solid-js";
import type { Coords } from "../coords";
import type { DrawingPane } from "../pane-coords";
import type { findOverlaySpec } from "lightweight-charts-drawing/core/specs";
import type { DataPoint, Drawing } from "lightweight-charts-drawing/core/types";
import type { Pt } from "lightweight-charts-drawing/core/_shared";
import type { DragState } from "lightweight-charts-drawing/core/interact/drag";
import type { CursorMode } from "../../../data/drawing-toolbar";
import type { SunkPainter } from "../DrawingsOverlay";

import type { FramesApi } from "./frames";
import type { TablesApi } from "./table";
import type { ImagesApi } from "./image";
import type { RegionToolsApi } from "./region-tools";
import type { DemonstrationApi } from "./demonstration";
import type { SunkApi } from "./sunk";
import type { PlacementApi } from "./placement";
import type { TextEditApi } from "./text-edit";
import type { SelectionApi } from "./selection";
import type { WindowEventsApi } from "./window-events";
import type { PriceLinesApi } from "./price-lines";
import type { ScaleMarksApi } from "./scale-marks";
import type { PopupsApi } from "./popups";
import type { LayersApi } from "./layers";
import type { SyncMode } from "../DrawingToolbar";

export type OverlayProps = {
  /** Main series pane coords. */
  coords: Coords | null;
  /** Drawings the chart paints on its canvas, behind a series (their place
   *  in the drawing order): here they are transparent pointer targets with
   *  their anchors. */
  sunk?: ReadonlySet<string>;
  /** The painter of those drawings, for the chart (null on unmount). */
  onPainter?: (paint: SunkPainter | null) => void;
  /** Chart panes the drawings live in (Drawing.owner). Absent = one pane,
   *  the main series, over the whole overlay. */
  panes?: DrawingPane[];
  /** Bumped on time-scale changes; the overlay re-renders to re-project. */
  coordEpoch: number;
  /** Width of a price scale on the LEFT of the plot (0 = none): the overlay
   *  starts after it, so x = 0 is the plot's left edge. */
  leftInset?: number;
  /** Price text of the main pane's price scale (the chart's price format). */
  formatPrice?: (price: number) => string;
  drawings: Drawing[];
  armedTool: string | null;
  /** Cursor-group interaction mode. `eraser` removes drawings under the pointer
   *  (click + sweep); `demonstration` draws a circle cursor (+ Alt highlighter);
   *  the rest just set the pointer glyph (handled on the chart host). */
  cursorMode?: CursorMode;
  /** Staged glyph for the `font-icon` tool — a Unicode emoji char or raw
   *  `<svg>` markup; attached to the placed drawing. */
  armedGlyph?: string;
  /** Snap placement clicks + drags to the closest OHLC of the bar under the
   *  cursor. Driven by the Magnet toggle. */
  magnet: boolean;
  /** Chart background (solid or vertical gradient) — anchors are filled with
   *  the background at their height. */
  anchorBg?: { top: string; bottom: string; gradient: boolean };
  /** Magnet strength: "strong" always snaps to the nearest OHLC level; "weak"
   *  only engages within MAGNET_WEAK_RADIUS_PX of a level (else the raw cursor
   *  is kept). */
  magnetMode?: "weak" | "strong";
  /** Also snap to price-pane overlay-indicator values (the "Snap to
   *  indicator" magnet sub-option). */
  magnetSnapsToIndicators?: boolean;
  /** An armed tool's cursor in the main pane (x in the plot, the price with the magnet), for the chart's own
   *  crosshair: its lines and its labels on both scales follow the cursor before the first point, as in the
   *  reference app (#179); null when the cursor leaves the pane or the tool is disarmed. Without it the overlay
   *  draws dashed guide lines. */
  onArmedCursor?: (at: { x: number; price: number } | null) => void;
  /** After placing a drawing, keep the same tool armed instead of clearing.
   *  Driven by the Keep-drawing toggle. */
  stayMode: boolean;
  /** Places a new drawing and returns its assigned id (so paste can select it). */
  onPlace: (d: import("lightweight-charts-drawing/core/types").NewDrawing) => string | void;
  onDisarm: () => void;
  selectedId: string | null;
  /** Full multi-selection (ordered, last = primary = selectedId). Absent →
   *  single-select behaviour only. */
  selectedIds?: string[];
  setSelectedId: (id: string | null) => void;
  /** Ctrl/Cmd+click membership toggle (multi-select). */
  onToggleSelect?: (id: string) => void;
  /** `label`: the undo text of a named action (menu Reverse). */
  onUpdate: (d: Drawing, label?: string) => void;
  /** Bulk replace for group body-drags / group nudges — one undo entry. */
  onUpdateMany?: (list: Drawing[]) => void;
  /** One drawing, or several in one step (menu Clone on a multi-selection). */
  onClone: (id: string | string[]) => void;
  /** Sync of a drawing (the scope it is kept in: its pane, the layout, every chart) and its change. */
  drawingSync?: (id: string) => SyncMode | null;
  onSync?: (ids: string[], mode: SyncMode) => void;
  onReorder: (id: string, dir: "front" | "forward" | "backward" | "back") => void;
  onRemove: (id: string) => void;
  /** Bulk delete for multi-select Delete — one undo entry. */
  onRemoveMany?: (ids: string[]) => void;
  /** TRUE when this overlay's pane is focused. Arrow-key nudges (broadcast from
   *  App as `drawing-nudge`) only apply on the active pane, so panes sharing a
   *  symbol — which all render the selected drawing — don't each move it. */
  active?: boolean;
  /** False while the pane's tab is hidden (the tab stays mounted): the
   *  window-wide key / paste / nudge / click-outside / place-at-cursor
   *  handlers belong to the shown tab. */
  shown?: boolean;
  /** Chart interval ("5", "240", "1D"…) — drives the per-drawing Visibility
   *  matrix (Settings → Visibility). Absent = no interval filtering. */
  interval?: string;
  /** Bare ticker of this pane's symbol — used to prefill the alert dialog
   *  from the selected toolbar's Add-alert button. */
  symbol?: string;
};

// ── Drawing panes ────────────────────────────────────────────────────────
// A drawing lives in its owner's pane (Drawing.owner = study id, absent =
// the main series pane): drawn, clipped and hit-tested there, in the pane's
// own pixel space (y = 0 at the pane top) and price scale. A placement
// stays in the pane of its first click. A vertical line with "Extend" on
// runs through every pane.
export type Frame = { key: string | null; top: number; dims: { w: number; h: number }; coords: Coords; clip: string };

/** Open context menu state — viewport coords + the drawing it targets. */
export type MenuState = { drawing: Drawing; pos: { x: number; y: number } };

/** State and functions the overlay component itself owns. */
export interface OverlayCore {
  props: OverlayProps;
  anchorFillAt: (y: number) => string;
  armedSpec: () => ReturnType<typeof findOverlaySpec>;
  cmode: () => CursorMode;
  ctrlDown: Accessor<boolean>;
  cursor: Accessor<Pt | null>;
  drag: Accessor<DragState | null>;
  erasing: boolean;
  hoveredId: Accessor<string | null>;
  intervalHidden: (d: Drawing) => boolean;
  menu: Accessor<MenuState | null>;
  notShown: (d: Drawing) => boolean;
  pending: Accessor<DataPoint[]>;
  setCtrlDown: Setter<boolean>;
  setCursor: Setter<Pt | null>;
  setDrag: Setter<DragState | null>;
  setHoveredId: Setter<string | null>;
  setMenu: Setter<MenuState | null>;
  setPending: Setter<DataPoint[]>;
  setShiftDown: Setter<boolean>;
  setSize: Setter<{ w: number; h: number }>;
  shiftDown: Accessor<boolean>;
  size: Accessor<{ w: number; h: number }>;
  svg: SVGSVGElement;
}

export type OverlayCx = OverlayCore &
  FramesApi &
  TablesApi &
  ImagesApi &
  RegionToolsApi &
  DemonstrationApi &
  SunkApi &
  PlacementApi &
  TextEditApi &
  SelectionApi &
  WindowEventsApi &
  PriceLinesApi &
  ScaleMarksApi &
  PopupsApi &
  LayersApi;

/** Add a part's functions (and its state accessors) to the context. */
export function attach<T extends object>(cx: OverlayCx, api: T): T {
  Object.defineProperties(cx, Object.getOwnPropertyDescriptors(api));
  return api;
}
