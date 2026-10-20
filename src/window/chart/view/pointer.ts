/*
 * Pointer and crosshair handling of a chart view: wheel zoom and price-axis
 * wheel, pointer tracking over drawings, the plus button press, Shift + click
 * measure, Ctrl + double click collapse, study drag, the crosshair (legend,
 * sync broadcast, hovered study), clicks on studies / news / history end, and
 * the time-sync click.
 */
import { onCleanup } from "solid-js";
import { PriceScaleMode, type ISeriesApi, type SeriesType, type MouseEventParams, type Time } from "lightweight-charts";
import { crosshairLockTime } from "../crosshair-lock";
import { NEWS_LOLLIPOP_ID } from "../news-lollipop";
import { HISTORY_END_ID } from "../history-end-marker";
import { layoutSync } from "../layout-sync";
import { activeLink, crossWindowCrosshairOn, postLinkTime } from "../../../data/tab-link-bus";
import { WheelHelper } from "../wheel-helper";
import { cursorForMode } from "../../drawings/cursors";
import { MEASURE_START_EVENT } from "../../drawings/overlay/region-tools";
import { roundedPrice } from "./helpers";
import { type ChartCx } from "./context";
import { emitAppEvent } from "../../../data/app-events";
import { MAIN_SOURCE_ID } from "../object-tree-sources";

/** What createPointer adds to the chart context. */
export interface PointerApi {
  installPointer: () => void;
  installTimeSync: () => void;
}

export function createPointer(cx: ChartCx): PointerApi {
  /** The main series is under the pointer (its drag). */
  let mainHovered = false;
  /** Top of the price pane (its sources hit-test in pane space). */
  const mainTop = () => cx.paneBoxes().find((b) => b.index === cx.mainPane())?.top ?? 0;
  const { historyEnd, indLegend, mainLastIndex, newsLollipop, paneId, props, refreshIndicatorLegend, refreshLegend, selectStudy, selectedStudy, setSelectedStudy, syncLockPanes, whenShown } = cx;
  function installPointer() {
    // ── Right-edge-anchored wheel zoom ──────────────────────────────────────
    // The wheel zoom pins the most recent bar to the right edge, so history
    // expands/contracts to the LEFT only — unlike lightweight-charts' default
    // cursor-anchored zoom. We hold the visible range's right edge (`to`) fixed
    // and scale the left edge (`from`). The whole wheel goes through the wheel
    // helper (./wheel-helper): vertical → zoom (bar spacing x (1 + t/10),
    // |t| <= 1 per event); Ctrl → "focused zoom", the bar under the cursor
    // stays put; horizontal (and Shift + vertical, swapped by the helper) →
    // scrollChart(-80 x deltaX) px. The library's own wheel scroll is replaced,
    // so the event stops here. Capture phase: we run before the canvas listener.
    const wheel = new WheelHelper();
    const axisWheel = new WheelHelper();
    const onWheel = (e: WheelEvent) => {
      if (!cx.chart) return;
      if (onPriceAxisWheel(e)) return;
      const ts = cx.chart.timeScale();
      let range = ts.getVisibleLogicalRange();
      if (!range) return;
      let span = range.to - range.from;
      if (span <= 0) return;
      const w = wheel.process(e);
      const zoom = -w.deltaY;
      if (zoom === 0 && w.deltaX === 0) return;
      e.preventDefault();
      e.stopPropagation();
      if (w.deltaX !== 0) {
        // Scroll by -80 · deltaX: the content moves that many pixels
        // (positive = to the right, i.e. toward older bars).
        const px = -80 * w.deltaX;
        const shift = px / (ts.width() / span);
        ts.setVisibleLogicalRange({ from: range.from - shift, to: range.to - shift });
        range = ts.getVisibleLogicalRange() ?? range;
        span = range.to - range.from;
      }
      if (zoom === 0) return;
      const t = Math.sign(zoom) * Math.min(1, Math.abs(zoom));
      props.onWheelZoom?.(e.ctrlKey || e.metaKey);
      // Wheel up (t > 0) → zoom in (smaller span); down → zoom out.
      const newSpan = Math.max(5, span / (1 + t / 10));
      if (e.ctrlKey || e.metaKey) {
        // Focused zoom: the logical index under the cursor keeps its screen
        // position. x clamped to [1, width - 2].
        const g = cx.scaleGeom();
        const r = cx.host.getBoundingClientRect();
        const x = Math.max(1, Math.min(e.clientX - r.left - (g?.left ? g.w : 0), ts.width() - 2));
        const at = ts.coordinateToLogical(x);
        if (at === null) return;
        const f = (at - range.from) / span;
        ts.setVisibleLogicalRange({ from: at - f * newSpan, to: at - f * newSpan + newSpan });
        return;
      }
      // The right margin (in bars) is kept, so the right edge stays put and
      // the left edge moves. The margin is then clamped to the bars on
      // screen minus 2: a view that is almost all whitespace past the last
      // bar slides left instead, keeping the last bar in view.
      const lastIndex = mainLastIndex();
      let to: number = range.to;
      if (lastIndex != null) to = Math.min(to, lastIndex + newSpan - 2);
      ts.setVisibleLogicalRange({ from: to - newSpan, to });
    };
    // Wheel over a price axis (on with handleScale.mouseWheel): scales that pane's price like an axis drag from
    // the cursor — startScale(y), scaleTo(y + 15 · deltaY), deltaY from its own
    // wheel helper: the price range is scaled around its centre by
    // (s0 + 0.2(h − 1)) / (s1 + 0.2(h − 1)), s = h − y (≥ 0), at least 0.1.
    // Not in percent / indexed-to-100 mode (the chart gets the wheel then).
    // TRUE when handled.
    function onPriceAxisWheel(e: WheelEvent): boolean {
      if (!cx.chart) return false;
      const r = cx.host.getBoundingClientRect();
      const x = e.clientX - r.left;
      // The axis under the pointer (both sides can show: the series in a
      // study pane it shares has the other side).
      const leftW = cx.leftAxisWidth();
      const rightW = cx.chart.priceScale("right").width();
      const side = leftW > 0 && x < leftW ? "left" : rightW > 0 && x >= r.width - rightW ? "right" : null;
      if (!side) return false;
      const box = cx.paneBoxes().find((b) => e.clientY - r.top >= b.top && e.clientY - r.top < b.top + b.height);
      if (!box) return false;
      const ps = cx.chart.priceScale(side, box.index);
      const mode = ps.options().mode;
      if (mode === PriceScaleMode.Percentage || mode === PriceScaleMode.IndexedTo100) return false;
      const range = ps.getVisibleRange();
      if (!range || !(range.to > range.from)) return false;
      const t = axisWheel.process(e).deltaY;
      if (t === 0) return false;
      e.preventDefault();
      e.stopPropagation();
      const h = box.height;
      const y = e.clientY - r.top - box.top;
      const s0 = h - y;
      const s1 = Math.max(0, h - (y + 15 * t));
      const k = Math.max(0.1, (s0 + 0.2 * (h - 1)) / (s1 + 0.2 * (h - 1)));
      // LWC keeps a log scale's range in its log space and setVisibleRange
      // stores the given numbers as they are, so a log scale is scaled (and
      // set) in that space, with LWC's own formula (toLog / logFormulaFor-
      // PriceRange: offsets 4 / 1e-4 unless the range is under 1).
      const log = mode === PriceScaleMode.Logarithmic;
      const diff = range.to - range.from;
      const digits = diff < 1 && diff >= 1e-15 ? Math.ceil(Math.abs(Math.log10(diff))) : 0;
      const lo = 4 + digits;
      const co = digits ? 1 / Math.pow(10, lo) : 0.0001;
      const toLog = (p: number) => (Math.abs(p) < 1e-15 ? 0 : Math.sign(p) * (Math.log10(Math.abs(p) + co) + lo));
      const a = log ? toLog(range.from) : range.from;
      const b = log ? toLog(range.to) : range.to;
      const mid = (a + b) / 2;
      const half = ((b - a) / 2) * k;
      ps.setVisibleRange({ from: mid - half, to: mid + half });
      return true;
    }
    cx.host.addEventListener("wheel", onWheel, { passive: false, capture: true });
    onCleanup(() => cx.host.removeEventListener("wheel", onWheel, { capture: true } as EventListenerOptions));

    // Track whether the OS pointer is over this pane (crosshair broadcast gate).
    // Capture phase so a canvas stopPropagation can't hide the events from us.
    const onDragMove = () => (cx.pointerOverHost = true);
    const onPointerEnter = () => (cx.pointerOverHost = true);
    // The pointer left this pane: stop owning the crosshair, and tell synced
    // siblings to clear (the terminal crosshairMove the library fires on leave
    // is gated off by pointerOverHost, so emit the clear ourselves — order-proof
    // regardless of whether pointerleave or the library's mouseleave runs first).
    const leaveChart = () => {
      cx.pointerOverHost = false;
      if (layoutSync().crosshair || crossWindowCrosshairOn()) {
        emitAppEvent("chart-sync-crosshair", { time: null, price: null, sourceId: paneId });
      }
    };
    // A drawing of this chart is above the chart canvas (its SVG takes the
    // pointer): the pointer is still over the chart. The reference keeps the
    // crosshair (lines, date and price labels, synced charts) over drawings,
    // so mouse moves over a drawing are passed on to the chart canvas under
    // the pointer; the chart would otherwise see the mouse leave.
    const onDrawing = (t: EventTarget | null) => {
      const el = t as Element | null;
      return !!el?.closest?.("[data-drawing-id]") && cx.paneRoot.contains(el);
    };
    let fwd: Element | null = null;
    const mouseInit = (e: MouseEvent): MouseEventInit => ({
      clientX: e.clientX, clientY: e.clientY, screenX: e.screenX, screenY: e.screenY,
      button: e.button, buttons: e.buttons, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey,
      view: window,
    });
    const fwdLeave = (e: MouseEvent) => {
      const t = fwd;
      fwd = null;
      t?.dispatchEvent(new MouseEvent("mouseleave", mouseInit(e)));
    };
    const onPointerLeave = (e: PointerEvent) => {
      if (onDrawing(e.relatedTarget)) return;
      leaveChart();
    };
    // A press on a drawing (its drag): no mouse moves reach the chart until
    // the release, wherever the pointer is.
    let dragging = false;
    const onDrawingDown = (e: PointerEvent) => {
      if (e.button === 0 && onDrawing(e.target) && !props.armedTool) dragging = true;
    };
    const onDrawingUp = () => { dragging = false; };
    const onDrawingMove = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      if (!(onDrawing(e.target) || dragging) || props.armedTool) {
        // Back on the canvas the moves went to: it had its own mouse enter.
        if (fwd && e.target !== fwd) fwdLeave(e);
        else fwd = null;
        return;
      }
      cx.pointerOverHost = true;
      const cv = document.elementsFromPoint(e.clientX, e.clientY).find((el) => el instanceof HTMLCanvasElement && cx.host.contains(el)) ?? null;
      if (cv !== fwd) {
        if (fwd) fwdLeave(e);
        cv?.dispatchEvent(new MouseEvent("mouseenter", mouseInit(e)));
        fwd = cv;
      }
      fwd?.dispatchEvent(new MouseEvent("mousemove", mouseInit(e)));
    };
    // Left the chart from a drawing.
    const onRootLeave = (e: MouseEvent) => {
      if (!fwd) return;
      fwdLeave(e);
      leaveChart();
    };
    cx.host.addEventListener("pointermove", onDragMove, true);
    cx.host.addEventListener("pointerenter", onPointerEnter, true);
    cx.host.addEventListener("pointerleave", onPointerLeave, true);
    cx.paneRoot.addEventListener("pointermove", onDrawingMove, true);
    cx.paneRoot.addEventListener("pointerdown", onDrawingDown, true);
    window.addEventListener("pointerup", onDrawingUp, true);
    cx.paneRoot.addEventListener("pointerleave", onRootLeave);
    onCleanup(() => {
      cx.host.removeEventListener("pointermove", onDragMove, true);
      cx.host.removeEventListener("pointerenter", onPointerEnter, true);
      cx.host.removeEventListener("pointerleave", onPointerLeave, true);
      cx.paneRoot.removeEventListener("pointermove", onDrawingMove, true);
      cx.paneRoot.removeEventListener("pointerdown", onDrawingDown, true);
      window.removeEventListener("pointerup", onDrawingUp, true);
      cx.paneRoot.removeEventListener("pointerleave", onRootLeave);
    });

    // Plus button hit test: a left press inside its rect belongs to the
    // button (no pan, no time click); the release inside it opens the menu.
    const inPlus = (e: MouseEvent) => {
      if (!cx.plusEl || cx.plusY() === null) return null;
      const r = cx.plusEl.getBoundingClientRect();
      if (!(e.clientX >= r.left && e.clientX < r.right && e.clientY >= r.top && e.clientY < r.bottom)) return null;
      // The news lollipop (a chart source) wins over the plus icon.
      if (cx.chart && cx.paneRoot) {
        const root = cx.paneRoot.getBoundingClientRect();
        const x = e.clientX - root.left - cx.leftAxisWidth();
        const y = e.clientY - root.top - mainTop();
        if (newsLollipop.hitTest(x, y) || historyEnd.hitTest(x, y)) return null;
      }
      return r;
    };
    const onPlusDown = (e: MouseEvent) => {
      if (e.button !== 0 || !inPlus(e)) return;
      cx.plusPressed = true;
      e.stopPropagation();
      e.preventDefault();
    };
    const onPlusUp = (e: MouseEvent) => {
      if (!cx.plusPressed) return;
      e.stopPropagation();
      if (e.type !== "click") return;
      cx.plusPressed = false;
      const r = inPlus(e);
      const y = cx.plusY();
      if (r && y !== null) cx.openPlusMenu(r, y);
    };
    const plusEvents = ["pointerdown", "mousedown"] as const;
    const plusUpEvents = ["pointerup", "mouseup", "click"] as const;
    for (const t of plusEvents) cx.host.addEventListener(t, onPlusDown, true);
    for (const t of plusUpEvents) cx.host.addEventListener(t, onPlusUp, true);
    onCleanup(() => {
      for (const t of plusEvents) cx.host.removeEventListener(t, onPlusDown, true);
      for (const t of plusUpEvents) cx.host.removeEventListener(t, onPlusUp, true);
    });

    // Shift+Click on empty chart → arm the Measure tool and start the measure
    // at the click (as in the reference app: this press is its first point,
    // the next click ends it). The overlay (a sibling of the host) takes the
    // press through MEASURE_START_EVENT. The press still reaches the chart, so
    // a Shift+drag also pans it while the ruler follows the pointer. Only on
    // the focused pane, when no tool is already armed, not on the Plus button.
    // Clicks on a drawing go to the overlay, not here.
    const onShiftMeasure = (e: MouseEvent) => {
      if (!props.active || props.armedTool || cx.plusPressed || e.button !== 0 || !e.shiftKey) return;
      emitAppEvent("select-drawing-tool", { toolId: "measure" });
      cx.host.parentElement?.dispatchEvent(new CustomEvent(MEASURE_START_EVENT, { detail: e }));
    };
    cx.host.addEventListener("mousedown", onShiftMeasure, true);
    onCleanup(() => cx.host.removeEventListener("mousedown", onShiftMeasure, true));

    // Ctrl+double click on an empty pane area → collapse / restore that pane
    // (no source under the cursor, no drawing tool, empty selection). The plain double click (maximize pane)
    // is not offered here. Only drawings are excluded as sources: a series /
    // study hit (which would open its settings) is not tested.
    const onCtrlDblClick = (e: MouseEvent) => {
      if (!(e.ctrlKey || e.metaKey) || props.armedTool) return;
      if (props.selectedDrawingId || (props.selectedDrawingIds?.length ?? 0) > 0) return;
      if ((e.target as Element | null)?.closest?.("[data-drawing-id]")) return;
      const g = cx.scaleGeom();
      if (!g) return;
      const r = cx.host.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      if (g.left ? x < g.w : x > r.width - g.w) return; // price axis, not the pane
      const box = cx.paneBoxes().find((b) => y >= b.top && y < b.top + b.height);
      if (!box) return;
      const a = cx.paneActions(box.index);
      if (!a.collapse && !a.restore) return;
      cx.toggleCollapse(box.index);
    };
    cx.host.addEventListener("dblclick", onCtrlDblClick);
    onCleanup(() => cx.host.removeEventListener("dblclick", onCtrlDblClick));

    // Study drag (reference rules): a press on a study's plot drags the study
    // (the press also scrolls the chart). Released over another pane, the
    // study joins that pane; released over the time axis, it goes to a new
    // pane at the bottom (or its pane moves to the bottom when it is alone in
    // it). The scroll the press made is kept (observed on the reference for
    // a study and the series alike). "Grabbing" cursor while dragging. Not
    // with Lock indicators, a drawing tool or the eraser. The main series is
    // dragged the same way (sources.ts: onto a study pane it joins it, the
    // studies drawn over it stay); "Lock indicators" is a study rule
    // (reference isDraggable of studies), not applied to the series.
    let studyDrag: { id: string; x: number; y: number; moved: boolean } | null = null;
    const onStudyDragDown = (e: MouseEvent) => {
      studyDrag = null;
      if (e.button !== 0 || !cx.chart || props.armedTool) return;
      if (props.cursorMode === "eraser" || props.cursorMode === "demonstration") return;
      if ((e.target as Element | null)?.closest?.("[data-drawing-id]")) return;
      const id = cx.hoveredStudy;
      if (!id && mainHovered) {
        studyDrag = { id: MAIN_SOURCE_ID, x: e.clientX, y: e.clientY, moved: false };
        return;
      }
      if (props.indicatorsLocked) return;
      if (!id || cx.compareEntry(id) || !indLegend().some((r) => r.id === id)) return;
      studyDrag = { id, x: e.clientX, y: e.clientY, moved: false };
    };
    const onStudyDragMove = (e: MouseEvent) => {
      if (!studyDrag || studyDrag.moved) return;
      if (Math.hypot(e.clientX - studyDrag.x, e.clientY - studyDrag.y) < 3) return;
      studyDrag.moved = true;
      cx.host.style.cursor = "grabbing";
    };
    const onStudyDragUp = (e: MouseEvent) => {
      const d = studyDrag;
      studyDrag = null;
      if (!d || !d.moved) return;
      cx.host.style.cursor = cursorForMode(props.cursorMode ?? "cross", !!props.armedTool);
      if (!cx.chart || !cx.controller) return;
      const r = cx.host.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return;
      const series = d.id === MAIN_SOURCE_ID;
      const from = series ? cx.mainPane() : cx.controller.paneOf(d.id);
      const overTimeAxis = r.bottom - e.clientY <= cx.chart.timeScale().height();
      const to = overTimeAxis ? null : cx.paneAtY(e.clientY - r.top);
      // After the chart has handled this release (its pressed pane may close).
      setTimeout(() => {
        const onPane = to !== null && to !== from && !cx.collapsedPanes().has(to);
        if (series) {
          if (overTimeAxis) cx.dropSeriesOnTimeAxis();
          else if (onPane) cx.mergeSeriesToPane(to);
        } else if (overTimeAxis) cx.dropStudyOnTimeAxis(d.id);
        else if (onPane) cx.mergeStudyToPane(d.id, to);
      }, 0);
    };
    cx.host.addEventListener("mousedown", onStudyDragDown, true);
    window.addEventListener("mousemove", onStudyDragMove, true);
    window.addEventListener("mouseup", onStudyDragUp, true);
    onCleanup(() => {
      cx.host.removeEventListener("mousedown", onStudyDragDown, true);
      window.removeEventListener("mousemove", onStudyDragMove, true);
      window.removeEventListener("mouseup", onStudyDragUp, true);
    });

    // Legend tracks the crosshair: hovering a bar shows that bar's values;
    // moving off the pane (no `time`) falls back to the latest bar.
    const onCrosshair = (param: MouseEventParams) => {
      cx.crosshairActive = param.time != null;
      const inPricePane = ((param as { paneIndex?: number }).paneIndex ?? 0) === cx.mainPane();
      cx.crosshairAt =
        param.point && param.time != null && inPricePane
          ? { time: param.time as number, y: param.point.y }
          : null;
      // Locked cursor line: the legend shows the locked bar.
      const locked = crosshairLockTime();
      if (cx.lockViews) cx.lockViews.shown = !!param.point;
      if (locked !== null) syncLockPanes();
      cx.lastLegendTime = (cx.crosshairActive && locked !== null ? locked : param.time) as number | undefined;
      refreshLegend(cx.lastLegendTime);
      refreshIndicatorLegend(cx.lastLegendTime);
      // Sync-in-layout (panes) OR "Sync crosshair across windows": mirror the
      // crosshair by time. tab-link-bus relays this same window event to the
      // other windows; each receiver applies it only when its own layout's
      // Crosshair sync is on.
      if (
        cx.pointerOverHost &&
        !cx.suppressCrosshairBroadcast &&
        (layoutSync().crosshair || crossWindowCrosshairOn())
      ) {
        // Resolve a broadcastable (time, price) for BOTH crosshair lines:
        //   • time  → vertical line. `param.time` is undefined when the cursor
        //     is over future/empty whitespace (right of the last bar), even
        //     though the cursor is still ON the chart and its own crosshair is
        //     drawn. Broadcasting null there made every synced pane CLEAR its
        //     crosshair (it vanished). Extrapolate the time from the logical
        //     index + the last bar step so siblings keep tracking. A null
        //     `point` means the cursor truly left the pane → broadcast null so
        //     receivers clear.
        //   • price → horizontal line. Send the price UNDER THE CURSOR so the
        //     horizontal line mirrors too; previously receivers pinned it to
        //     the latest close (the line never followed the source cursor).
        let time: number | null = (param.time as number | undefined) ?? null;
        let price: number | null = null;
        if (param.point) {
          if (time == null && param.logical != null && cx.raw.length >= 2) {
            const last = cx.raw.length - 1;
            const step = (cx.raw[last].time as number) - (cx.raw[last - 1].time as number);
            time = (cx.raw[last].time as number) + ((param.logical as number) - last) * step;
          }
          // The price on the series' scale: in its pane only.
          const p = inPricePane ? cx.series?.coordinateToPrice(param.point.y) : null;
          if (p != null) price = p as number;
        }
        emitAppEvent("chart-sync-crosshair", { time, price, sourceId: paneId });
      }
    };
    cx.chart!.subscribeCrosshairMove(onCrosshair);
    // Plus button: follows the crosshair in the pane under the pointer (not
    // a collapsed pane) while the pointer is over the chart, not while a
    // drawing tool is armed.
    const onPlusCrosshair = (param: MouseEventParams<Time>) => {
      const pane = (param as { paneIndex?: number }).paneIndex ?? 0;
      const box = cx.paneBoxes().find((b) => b.index === pane);
      const shown = param.point && cx.pointerOverHost && !props.armedTool && (pane === cx.mainPane() || (!!box && !cx.collapsedPanes().has(pane)));
      cx.setPlusPane(pane);
      cx.setPlusY(shown ? (box?.top ?? 0) + param.point!.y : null);
    };
    cx.chart!.subscribeCrosshairMove(onPlusCrosshair);
    // Latest news lollipop: hover state + crosshair lines hidden on hover.
    let newsHovered = false;
    const onNewsCrosshair = (param: MouseEventParams<Time>) => {
      const hov = param.hoveredObjectId === NEWS_LOLLIPOP_ID;
      if (hov === newsHovered) return;
      newsHovered = hov;
      newsLollipop.setState({ hovered: hov });
      cx.chart?.applyOptions({ crosshair: { vertLine: { visible: !hov && crosshairLockTime() === null }, horzLine: { visible: !hov } } });
    };
    cx.chart!.subscribeCrosshairMove(onNewsCrosshair);
    const onHistoryEndCrosshair = (param: MouseEventParams<Time>) => {
      historyEnd.setState({ hovered: param.hoveredObjectId === HISTORY_END_ID });
    };
    cx.chart!.subscribeCrosshairMove(onHistoryEndCrosshair);
    // Click on a plot selects its study (or compared symbol); a click on the
    // empty chart or the main series clears the selection. The library counts
    // a click within 500 ms of another as a double click: both select.
    const onStudyClick = (param: MouseEventParams<Time>) => {
      if (props.armedTool) return;
      const s = (param.hoveredInfo?.series ?? param.hoveredSeries) as ISeriesApi<SeriesType> | undefined;
      const id = s ? cx.studyOfSeries(s) : null;
      if (id) selectStudy(id);
      else if (selectedStudy()) setSelectedStudy(null);
    };
    cx.chart!.subscribeClick(onStudyClick);
    cx.chart!.subscribeDblClick(onStudyClick);
    // Study under the pointer (its plot is hovered), for the right click;
    // the main series under it, for its drag.
    const onStudyHover = (param: MouseEventParams<Time>) => {
      const s = (param.hoveredInfo?.series ?? param.hoveredSeries) as ISeriesApi<SeriesType> | undefined;
      cx.hoveredStudy = param.point && s ? cx.studyOfSeries(s) : null;
      mainHovered = !!param.point && !!s && s === (cx.series as unknown);
      cx.crosshairPrice = null;
      if (param.point && cx.pointerOverHost) {
        const pane = (param as { paneIndex?: number }).paneIndex ?? 0;
        const inPricePane = pane === cx.mainPane();
        const owner = inPricePane ? null : cx.controller?.ownerOfPane(pane) ?? null;
        const src = inPricePane ? cx.series : owner ? cx.controller?.studySeries(owner) ?? null : null;
        const p = src?.coordinateToPrice(param.point.y);
        if (src && p != null) {
          const fmt = src.priceFormatter();
          cx.crosshairPrice = roundedPrice(p as number, (n) => fmt.format(n));
        }
      }
    };
    cx.chart!.subscribeCrosshairMove(onStudyHover);
    // Click on the lollipop toggles its card; any other chart click closes it
    // (click outside). A DOM click, not the library's click event:
    // the library drops a click that follows another within 500 ms (it is
    // counted as a double click).
    const onNewsClick = (e: MouseEvent) => {
      if (e.button !== 0 || !cx.chart || !cx.paneRoot) return;
      const root = cx.paneRoot.getBoundingClientRect();
      const x = e.clientX - root.left - cx.leftAxisWidth();
      const y = e.clientY - root.top - mainTop();
      if (newsLollipop.hitTest(x, y)) cx.toggleNewsCard();
      else if (cx.newsCardOpen()) cx.setNewsCardOpen(false);
      if (historyEnd.hitTest(x, y)) cx.openHistoryEndDialog();
    };
    cx.host.addEventListener("click", onNewsClick, true);
    onCleanup(() => {
      cx.chart?.unsubscribeCrosshairMove(onCrosshair);
      cx.chart?.unsubscribeCrosshairMove(onPlusCrosshair);
      cx.chart?.unsubscribeCrosshairMove(onNewsCrosshair);
      cx.chart?.unsubscribeClick(onStudyClick);
      cx.chart?.unsubscribeDblClick(onStudyClick);
      cx.host.removeEventListener("click", onNewsClick, true);
    });
  }

  function installTimeSync() {
    // The card closes on scroll / zoom.
    const onNewsRange = () => { if (cx.newsCardOpen()) cx.setNewsCardOpen(false); };
    cx.chart!.timeScale().subscribeVisibleLogicalRangeChange(onNewsRange);

    // "Time" sync, driver side: every left mouse-up inside the plot area of a
    // pane that was pressed there, including the end of a drag, sends the time
    // under the pointer. Not on a drawing, not while a tool is armed, and not
    // at all while date-range sync is on. Whitespace right of the last bar
    // extrapolates the time from the bar step (rough time). The same click is
    // sent to linked tabs when the group's Time channel is on and its Date
    // range channel is off (the Linker drops time when date range is on).
    let pressedHere = false;
    const onTimePress = (e: PointerEvent) => {
      // Shift+press arms Measure, Alt+press toggles maximize: not time clicks.
      pressedHere = e.button === 0 && !e.shiftKey && !e.altKey;
    };
    const onTimeRelease = (e: PointerEvent) => {
      const pressed = pressedHere;
      pressedHere = false;
      if (!pressed || e.button !== 0 || !cx.chart || cx.raw.length === 0) return;
      const toLayout = layoutSync().time && !layoutSync().dateRange;
      const link = activeLink();
      const toLink = !!link && link.channels.time && !link.channels.dateRange;
      if ((!toLayout && !toLink) || props.armedTool) return;
      if ((e.target as Element | null)?.closest?.("[data-drawing-id]")) return;
      const ts = cx.chart.timeScale();
      const rect = cx.host.getBoundingClientRect();
      const x = e.clientX - rect.left - cx.chart.priceScale("left").width();
      const y = e.clientY - rect.top;
      if (x < 0 || x >= ts.width() || y >= rect.height - ts.height()) return;
      let time = ts.coordinateToTime(x) as number | null;
      if (time == null) {
        const logical = ts.coordinateToLogical(x);
        if (logical == null || cx.raw.length < 2) return;
        const last = cx.raw.length - 1;
        const step = (cx.raw[last].time as number) - (cx.raw[last - 1].time as number);
        time = (cx.raw[last].time as number) + ((logical as number) - last) * step;
      }
      if (toLayout) emitAppEvent("chart-sync-time", { time, sourceId: paneId });
      if (toLink) postLinkTime(time);
    };
    cx.host.addEventListener("pointerdown", onTimePress, true);
    window.addEventListener("pointerup", whenShown(onTimeRelease), true);
    onCleanup(() => {
      cx.host.removeEventListener("pointerdown", onTimePress, true);
      window.removeEventListener("pointerup", whenShown(onTimeRelease), true);
    });
    onCleanup(() => cx.chart?.timeScale().unsubscribeVisibleLogicalRangeChange(onNewsRange));
  }

  return {
    installPointer,
    installTimeSync,
  };
}
