/*
 * ChartGrid — splits the chart pane into N INDEPENDENT ChartView cells per the
 * active layout template (window/chart/layouts.ts). Ported from the mock's
 * inline ChartGrid, then extended past it: each cell is its own chart with its
 * own symbol / interval / chart-type / indicators / drawings (the mock fed
 * every pane the same active-tab symbol).
 *
 * Geometry comes from the template's split tree (LAYOUT_SPECS[..].expr) and
 * the tab's sizes for that template (layout-sizes.ts): every cell is placed
 * by its pixel box, applied as inline styles, so chart-grid.css stays
 * template-agnostic. `panes[i]` supplies cell i's data (kept the same length
 * as `spec.cells` by the caller's reconcilePanes).
 *
 * Splitters: a 12 px band on every gap between two charts. Dragging one
 * moves the size between its two neighbours (5 % of their box at least);
 * with Shift the matching splitter of the sibling rows / columns moves too.
 * A double click puts the template back to equal sizes. No splitter while a
 * chart is maximized.
 *
 * EVERY pane is fully interactive: the armed drawing tool, magnet, selection
 * and edit callbacks reach all panes, but each pane's callbacks are bound to
 * ITS OWN symbol — so placing / dragging / editing on any pane lands on that
 * pane's chart in one gesture (no focus-first step). Acting on a pane also
 * focuses it (so the header / right-rail / object-tree follow). Each pane's
 * study legend removes from THAT pane via onRemoveIndicator(paneIndex, id).
 *
 * Drawings are keyed by a sync-mode scope key (drawingKeyForPane(pane)): per
 * pane, per layout, or per symbol. Panes resolving to the same key share the
 * slice, so an edit on one shows on the others. The global `selectedDrawingId`
 * is rendered by whichever pane owns that drawing.
 */
import type { CompareStyleState } from "./compare/compare-style";
import { createEffect, createMemo, createSignal, Index, on, onCleanup, onMount, Show, untrack } from "solid-js";
import { ChartEventHint } from "../../components/ChartEventHint";
import {
  DEMONSTRATION_HINT,
  hintState,
  lineToolHint,
  PATH_HINT,
  POLYLINE_HINT,
  setLineToolHint,
  ZOOM_HINT,
} from "../../data/hints";
import { ChartView } from "./ChartView";
import { LAYOUT_SPECS, type LayoutId } from "./layouts";
import {
  alignSiblings,
  applyResize,
  cellRects,
  cloneSizing,
  initialSizing,
  sizingFits,
  splitters,
  type Rect,
  type Sizing,
  type Splitter,
} from "./layout-sizes";
import type { PaneChart, PaneIndicatorSettings } from "../shell/tabs";
import type { Drawing, NewDrawing } from "lightweight-charts-drawing/core/types";
import type { CursorMode } from "../../data/drawing-toolbar";
import { displayTimeZone } from "../../data/session";

type Props = {
  /** False while this grid's tab is hidden. App keeps every opened tab's grid
   *  mounted (each tab page stays alive), so a tab switch is one paint: the
   *  hidden grid sits under the shown one at the same size (no resize, no
   *  reload) and takes no input. */
  shown?: boolean;
  layout: LayoutId;
  /** One entry per grid cell (same length as the layout's cells). */
  panes: PaneChart[];
  /** Index of the focused/interactive pane. */
  activePane: number;
  /** Focus a pane (clicking a cell). */
  setActivePane: (i: number) => void;
  /** When true, the focused pane fills the layout and the others are hidden
   *  ("Maximize chart"). All cells stay mounted so chart state is preserved. */
  maximized?: boolean;
  /** Toggle maximize (double-click a pane). Wired from App's maximize state. */
  onToggleMaximize?: () => void;
  /** The tab's sizes of this template (absent = equal sizes). */
  sizes?: Sizing;
  /** A splitter drag ended (`sizes`) or a splitter was double-clicked
   *  (undefined = back to equal sizes). */
  onSizes?: (sizes: Sizing | undefined) => void;
  theme?: "dark" | "light";
  timeZone?: string;
  /** The timezone row label (the time-axis menu checks it). */
  timeZoneLabel?: string;
  /** Reactive read of a scope key's drawings (each pane renders its own). */
  drawingsFor: (key: string) => Drawing[];
  /** Scope key for a pane under the active sync mode — the store/persist key the
   *  pane's drawings live under (per pane / per layout / per symbol). */
  drawingKeyForPane: (pane: PaneChart) => string;
  /** Remove a study from a specific pane (its legend trash). */
  onRemoveIndicator?: (paneIndex: number, id: string) => void;
  /** Persist a new study order for a pane (pane controls move up / down). */
  onReorderIndicators?: (paneIndex: number, ids: string[]) => void;
  /** Persist a study's edited inputs/styles onto a specific pane (Settings → Ok). */
  onIndicatorSettings?: (paneIndex: number, id: string, settings: PaneIndicatorSettings) => void;
  /** Compared symbols of a pane: patch / remove one, change its symbol. */
  onCompareChange?: (paneIndex: number, id: string, patch: { hidden?: boolean; symbol?: string; style?: CompareStyleState }) => void;
  onRemoveCompare?: (paneIndex: number, id: string) => void;
  onChangeCompareSymbol?: (paneIndex: number, id: string) => void;
  onPaneOrder?: (paneIndex: number, order: string[]) => void;
  onSourceOrder?: (paneIndex: number, order: string[]) => void;
  /** Persist a specific pane's settled visible logical range (its scroll/zoom
   *  anchor), so it survives tab switches + reloads. */
  onVisibleRange?: (paneIndex: number, range: { from: number; to: number; last?: number }) => void;
  /** Legend eye of pane `paneIndex` (hide / show its main series). */
  onToggleSeries?: (paneIndex: number) => void;
  /** Legend "Symbol/interval chart syncing" shown (several charts and Symbol
   *  or Interval sync on), and the group setter of pane `paneIndex`. */
  linkSyncVisible?: boolean;
  onLinkGroup?: (paneIndex: number, group: number | undefined) => void;
  /** Legend symbol title clicked ("Change symbol"). */
  onChangeSymbol?: () => void;
  /** Legend interval clicked ("Change interval"). */
  onChangeInterval?: () => void;
  /** Hide-all dropdown's "Hide indicators" — suppresses study layers on every
   *  pane without removing them from the active set. */
  indicatorsHidden?: boolean;
  // ── Per-pane interaction (callbacks bound to each pane's symbol) ────────
  armedTool?: string | null;
  cursorMode?: CursorMode;
  armedGlyph?: string;
  magnet?: boolean;
  magnetMode?: "weak" | "strong";
  magnetSnapsToIndicators?: boolean;
  stayMode?: boolean;
  onDisarm?: () => void;
  selectedDrawingId?: string | null;
  /** Full multi-selection (ordered, last = primary; see App). */
  selectedDrawingIds?: string[];
  setSelectedDrawingId?: (id: string | null) => void;
  /** Ctrl/Cmd+click membership toggle. */
  toggleSelectedDrawing?: (id: string) => void;
  onPlaceToSymbol?: (key: string, d: NewDrawing) => string | void;
  updateDrawingForSymbol?: (key: string, d: Drawing) => void;
  /** Bulk replace (group drag/nudge) — one undo entry. */
  updateDrawingsForSymbol?: (key: string, list: Drawing[]) => void;
  cloneDrawingForSymbol?: (key: string, id: string) => void;
  reorderDrawingForSymbol?: (key: string, id: string, dir: "front" | "forward" | "backward" | "back") => void;
  placeDrawingsForSymbol?: (key: string, ids: string[], over: Record<string, string | null>) => void;
  removeDrawingForSymbol?: (key: string, id: string) => void;
  /** Bulk delete (multi-select Delete) — one undo entry. */
  removeDrawingsForSymbol?: (key: string, ids: string[]) => void;
};

export function ChartGrid(props: Props) {
  const spec = () => LAYOUT_SPECS[props.layout];
  // Maximize only changes anything when there's more than one cell to enlarge
  // over. With a single-pane layout the grid already fills the area.
  const isMaximized = () => !!props.maximized && spec().cells.length > 1;
  const live = () => props.shown !== false;

  // ── Geometry ────────────────────────────────────────────────────────────
  // The gap between two charts (the window background shows through).
  const GAP = 2;
  let gridEl: HTMLDivElement | undefined;
  const [box, setBox] = createSignal({ width: 0, height: 0 });
  onMount(() => {
    if (!gridEl) return;
    const el = gridEl;
    const measure = () => setBox((b) => (b.width === el.clientWidth && b.height === el.clientHeight ? b : { width: el.clientWidth, height: el.clientHeight }));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    onCleanup(() => ro.disconnect());
  });
  // Sizes shown: the running drag, else the tab's sizes of this template.
  const [dragSizing, setDragSizing] = createSignal<Sizing | null>(null);
  const sizing = createMemo<Sizing>(() => {
    const expr = spec().expr;
    const drag = dragSizing();
    if (drag && sizingFits(expr, drag)) return drag;
    return sizingFits(expr, props.sizes) ? props.sizes : initialSizing(expr);
  });
  const contentBox = (): Rect => ({ left: 0, top: 0, width: box().width, height: box().height });
  // Until the grid is measured the cells take their share in percent, so a
  // chart never mounts in an empty box.
  const UNIT = 100000;
  const measured = () => box().width > 0 && box().height > 0;
  const rects = createMemo(() =>
    measured()
      ? cellRects(spec().expr, contentBox(), GAP, sizing())
      : cellRects(spec().expr, { left: 0, top: 0, width: UNIT, height: UNIT }, 0, sizing()),
  );
  const cellStyle = (i: number) => {
    const r = rects()[i];
    if (!r) return {};
    const unit = (v: number) => (measured() ? `${Math.max(v, 0)}px` : `${(v / UNIT) * 100}%`);
    return { left: unit(r.left), top: unit(r.top), width: unit(r.width), height: unit(r.height) };
  };
  const bars = createMemo<Splitter[]>(() =>
    measured() && !isMaximized() ? splitters(spec().expr, contentBox(), GAP, sizing()) : [],
  );

  // ── Splitter drag ───────────────────────────────────────────────────────
  // Highlighted splitter (pointer over it or dragged); with Shift every
  // splitter of its group lights up.
  const [hot, setHot] = createSignal<{ key: string; group: string; shift: boolean } | null>(null);
  const barKey = (s: Splitter) => s.indexes.join("-") + s.orientation;
  const isHot = (s: Splitter) => {
    const h = hot();
    return !!h && (h.shift ? h.group === s.group : h.key === barKey(s));
  };
  let drag: { splitter: Splitter; x: number; y: number; start: Sizing; aligned: Sizing; delta: number; moved: boolean } | null = null;
  const applyDrag = (shift: boolean) => {
    if (!drag) return;
    const base = cloneSizing(shift ? drag.aligned : drag.start);
    setDragSizing(applyResize(spec().expr, contentBox(), GAP, drag.delta, drag.splitter, base, shift));
  };
  // Shift pressed / released while dragging re-applies the move at once.
  const onShiftKey = (e: KeyboardEvent) => {
    if (e.key !== "Shift" || !drag || !drag.moved) return;
    setHot({ key: barKey(drag.splitter), group: drag.splitter.group, shift: e.type === "keydown" });
    applyDrag(e.type === "keydown");
  };
  const endDrag = () => {
    window.removeEventListener("keydown", onShiftKey, true);
    window.removeEventListener("keyup", onShiftKey, true);
    if (drag) document.body.style.cursor = "";
    drag = null;
  };
  onCleanup(endDrag);
  // Touch: a tap selects the splitter (lit), a second tap or a touch
  // elsewhere clears it; only a selected splitter is dragged.
  const isTouch = (e: PointerEvent) => e.pointerType === "touch";
  let tap: { key: string; x: number; y: number } | null = null;
  const onTouchOutside = (e: PointerEvent) => {
    if (!isTouch(e) || drag || (e.target as Element | null)?.closest?.(".chart-grid-splitter")) return;
    setHot(null);
  };
  window.addEventListener("pointerdown", onTouchOutside, true);
  onCleanup(() => window.removeEventListener("pointerdown", onTouchOutside, true));
  const onBarDown = (s: Splitter, e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    tap = isTouch(e) ? { key: barKey(s), x: e.clientX, y: e.clientY } : null;
    if (isTouch(e) && hot()?.key !== barKey(s)) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const start = cloneSizing(sizing());
    drag = { splitter: s, x: e.clientX, y: e.clientY, start, aligned: alignSiblings(spec().expr, s, cloneSizing(start)), delta: 0, moved: false };
    setHot({ key: barKey(s), group: s.group, shift: e.shiftKey });
    document.body.style.cursor = s.orientation === "v" ? "ns-resize" : "ew-resize";
    window.addEventListener("keydown", onShiftKey, true);
    window.addEventListener("keyup", onShiftKey, true);
  };
  const onBarMove = (e: PointerEvent) => {
    if (tap && Math.abs(e.clientX - tap.x) + Math.abs(e.clientY - tap.y) > 4) tap = null;
    if (!drag) return;
    drag.delta = drag.splitter.orientation === "v" ? e.clientY - drag.y : e.clientX - drag.x;
    drag.moved = true;
    setHot({ key: barKey(drag.splitter), group: drag.splitter.group, shift: e.shiftKey });
    applyDrag(e.shiftKey);
  };
  const onBarUp = (s: Splitter, e: PointerEvent) => {
    const tapped = tap?.key === barKey(s) && e.type === "pointerup";
    tap = null;
    if (!drag) {
      if (tapped) setHot({ key: barKey(s), group: s.group, shift: e.shiftKey });
      return;
    }
    const el = e.currentTarget as HTMLElement;
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    const next = drag.moved ? dragSizing() : null;
    endDrag();
    if (next) props.onSizes?.(next);
    setDragSizing(null);
    if (isTouch(e) ? tapped : !el.matches(":hover")) setHot(null);
  };

  // Chart event hints: ONE hint for the whole layout, centred 32 px above the
  // bottom of the chart area; a new hint replaces the shown one, a tool change
  // hides it, its close button dismisses its key for good.
  const [hint, setHint] = createSignal<{ key: string; text: string } | null>(null);
  // Tool change: hide, then the demonstration hint.
  createEffect(
    on(
      () => [props.cursorMode, props.armedTool] as const,
      ([mode, armed]) => {
        const demo = mode === "demonstration" && !armed && !hintState(DEMONSTRATION_HINT).dismissed();
        setHint(demo ? { key: DEMONSTRATION_HINT, text: "Hold Alt for temporary drawing" } : null);
      },
    ),
  );
  // Path / polyline first point shows its hint; a finish
  // or a tool change clears the shared signal (DrawingsOverlay).
  createEffect(() => {
    const l = lineToolHint();
    if (l) setHint(l);
    else if (untrack(hint)?.key === PATH_HINT || untrack(hint)?.key === POLYLINE_HINT) setHint(null);
  });
  // Zoom hint: the first wheel zoom WITHOUT Ctrl
  // shows "Press and hold Ctrl ..." (once per layout page); a later Ctrl zoom,
  // after it was shown, dismisses it for good; a Ctrl zoom ends the watch.
  let zoomShown = false;
  let zoomDone = false;
  const onWheelZoom = (mod: boolean) => {
    if (zoomDone || hintState(ZOOM_HINT).dismissed()) return;
    if (mod) {
      if (zoomShown) {
        hintState(ZOOM_HINT).dismiss();
        if (hint()?.key === ZOOM_HINT) setHint(null);
      }
      zoomDone = true;
      return;
    }
    if (!zoomShown) {
      zoomShown = true;
      setHint({ key: ZOOM_HINT, text: "Press and hold Ctrl while zooming to maintain the chart position" });
    }
  };
  const closeHint = (key: string) => {
    hintState(key).dismiss();
    if (key === PATH_HINT || key === POLYLINE_HINT) setLineToolHint(null);
    setHint(null);
  };

  return (
    <div
      class="chart-grid"
      data-layout={props.layout}
      aria-hidden={live() ? undefined : "true"}
      // Hidden grid: inert (no input, no focus, even where a child sets
      // pointer-events or visibility itself, e.g. the control bar buttons) and
      // painted under the chart area's background (negative z-index), so
      // nothing of it shows. The shown grid keeps no stacking context, so its
      // menus still layer above the rest of the window.
      inert={!live()}
      ref={gridEl}
      style={{
        visibility: live() ? undefined : "hidden",
        position: live() ? undefined : "absolute",
        inset: live() ? undefined : "0",
        "z-index": live() ? undefined : -1,
      }}
    >
      <Index each={spec().cells}>
        {(_cell, i) => {
          // Each cell's chart state comes from the matching pane (fall back to
          // pane 0 during the brief frame before reconcilePanes catches up).
          const pane = () => props.panes[i] ?? props.panes[0];
          const isActive = () => live() && i === props.activePane;
          // When maximized, the focused cell spans the whole grid and every
          // other cell is hidden (display:none keeps its ChartView mounted, so
          // restoring is instant and zoom/state survive). The cell's resize
          // observer in ChartView reflows the canvas to the new size.
          const maxed = () => isMaximized();
          return (
            <div
              class={`chart-grid-cell${isActive() ? " is-active" : ""}`}
              style={{
                ...(maxed() ? { left: "0", top: "0", width: "100%", height: "100%" } : cellStyle(i)),
                display: maxed() && !isActive() ? "none" : undefined,
              }}
              // Capture-phase: the drawings overlay stops pointer propagation
              // when a drawing is hit, so a bubbling handler would miss those
              // clicks. Capture fires before the overlay.
              //   mousedown → focus this pane; Alt + left-button toggles
              //               maximize (the expand-pane gesture). Stopping the
              //               event here keeps the Alt+click from also starting a
              //               pan/select on the pane underneath.
              // Skips when a tool is armed or the press landed on a drawing.
              ref={(el) => {
                const onDrawing = (e: Event) =>
                  !!(e.target as Element | null)?.closest?.("[data-drawing-id]");
                el.addEventListener("mousedown", (e) => {
                  props.setActivePane(i);
                  // Maximize hotkey: not with the demonstration
                  // cursor, where Alt + press draws a highlighter instead.
                  if (e.button === 0 && e.altKey && !props.armedTool && props.cursorMode !== "demonstration" && !onDrawing(e)) {
                    e.preventDefault();
                    e.stopPropagation();
                    props.onToggleMaximize?.();
                  }
                }, true);
              }}
            >
              <ChartView
                symbol={pane().symbol}
                interval={pane().interval}
                session={pane().session}
                chartType={pane().chartType}
                indicators={pane().indicators}
                compare={pane().compare}
                indicatorSettings={pane().indicatorSettings}
                onIndicatorSettings={(id, s) => live() && props.onIndicatorSettings?.(i, id, s)}
                visibleLogicalRange={pane().visibleLogicalRange}
                onVisibleRange={(r) => props.onVisibleRange?.(i, r)}
                settings={pane().settings}
                indicatorsHidden={props.indicatorsHidden}
                theme={props.theme}
                timeZone={displayTimeZone(props.timeZoneLabel ?? "", props.timeZone ?? "UTC", pane().symbol)}
                timeZoneLabel={props.timeZoneLabel}
                active={isActive()}
                shown={live()}
                // Control bar → maximize. Only offered when there is more
                // than one cell to grow over. No
                // setActivePane here: the cell's capture-phase mousedown above
                // already focused this pane before the click lands.
                canMaximize={spec().cells.length > 1}
                maximized={maxed()}
                onToggleMaximize={() => props.onToggleMaximize?.()}
                drawings={props.drawingsFor(props.drawingKeyForPane(pane()))}
                onRemoveIndicator={(id) => live() && props.onRemoveIndicator?.(i, id)}
                onCompareChange={(id, patch) => live() && props.onCompareChange?.(i, id, patch)}
                onRemoveCompare={(id) => live() && props.onRemoveCompare?.(i, id)}
                onChangeCompareSymbol={(id) => live() && props.onChangeCompareSymbol?.(i, id)}
                paneOrder={pane().paneOrder}
                onPaneOrder={(order) => live() && props.onPaneOrder?.(i, order)}
                sourceOrder={pane().sourceOrder}
                onSourceOrder={(order) => live() && props.onSourceOrder?.(i, order)}
                onReorderIndicators={(ids) => live() && props.onReorderIndicators?.(i, ids)}
                cursorMode={props.cursorMode}
                onWheelZoom={onWheelZoom}
                seriesHidden={!!pane().seriesHidden}
                onToggleSeries={() => props.onToggleSeries?.(i)}
                linkGroup={pane().linkGroup}
                linkSyncVisible={!!props.linkSyncVisible}
                onLinkGroup={(g) => props.onLinkGroup?.(i, g)}
                onChangeSymbol={props.onChangeSymbol}
                onChangeInterval={props.onChangeInterval}
                // Every pane is interactive; callbacks bind to this pane's
                // symbol, and acting on a pane focuses it.
                armedTool={props.armedTool}
                armedGlyph={props.armedGlyph}
                magnet={props.magnet}
                magnetMode={props.magnetMode}
                magnetSnapsToIndicators={props.magnetSnapsToIndicators}
                stayMode={props.stayMode}
                onDisarm={props.onDisarm}
                selectedDrawingId={props.selectedDrawingId}
                selectedDrawingIds={props.selectedDrawingIds}
                // A hidden grid takes no drawing action (its tab is not shown).
                onPlace={(d) => { if (!live()) return; props.setActivePane(i); return props.onPlaceToSymbol?.(props.drawingKeyForPane(pane()), d); }}
                setSelectedDrawingId={(id) => { if (!live()) return; props.setActivePane(i); props.setSelectedDrawingId?.(id); }}
                toggleSelectedDrawing={(id) => { if (!live()) return; props.setActivePane(i); props.toggleSelectedDrawing?.(id); }}
                updateDrawing={(d) => live() && props.updateDrawingForSymbol?.(props.drawingKeyForPane(pane()), d)}
                updateDrawings={(list) => live() && props.updateDrawingsForSymbol?.(props.drawingKeyForPane(pane()), list)}
                cloneDrawing={(id) => live() && props.cloneDrawingForSymbol?.(props.drawingKeyForPane(pane()), id)}
                reorderDrawing={(id, dir) => live() && props.reorderDrawingForSymbol?.(props.drawingKeyForPane(pane()), id, dir)}
                placeDrawings={(ids, over) => live() && props.placeDrawingsForSymbol?.(props.drawingKeyForPane(pane()), ids, over)}
                removeDrawing={(id) => live() && props.removeDrawingForSymbol?.(props.drawingKeyForPane(pane()), id)}
                removeDrawings={(ids) => live() && props.removeDrawingsForSymbol?.(props.drawingKeyForPane(pane()), ids)}
              />
            </div>
          );
        }}
      </Index>
      <Index each={bars()}>
        {(bar) => (
          <div
            class={`chart-grid-splitter${isHot(bar()) ? " is-hovered" : ""}`}
            data-splitter={barKey(bar())}
            aria-hidden="true"
            style={{
              left: `${bar().rect.left}px`,
              top: `${bar().rect.top}px`,
              width: `${bar().rect.width}px`,
              height: `${bar().rect.height}px`,
              cursor: bar().orientation === "v" ? "ns-resize" : "ew-resize",
            }}
            onPointerEnter={(e) => !drag && !isTouch(e) && setHot({ key: barKey(bar()), group: bar().group, shift: e.shiftKey })}
            onPointerLeave={(e) => !drag && !isTouch(e) && setHot(null)}
            onPointerDown={(e) => onBarDown(bar(), e)}
            onPointerMove={onBarMove}
            onPointerUp={(e) => onBarUp(bar(), e)}
            onPointerCancel={(e) => onBarUp(bar(), e)}
            onDblClick={() => props.onSizes?.(undefined)}
          />
        )}
      </Index>
      <Show when={live() && hint() && !hintState(hint()!.key).dismissed() ? hint() : null}>
        {(h) => <ChartEventHint text={h().text} onClose={() => closeHint(h().key)} />}
      </Show>
    </div>
  );
}
