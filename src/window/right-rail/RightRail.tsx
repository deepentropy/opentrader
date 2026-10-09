/*
 * RightRail — container that pairs the vertical tab strip with the active
 * panel. Panel sits to the LEFT of the strip. When
 * activeTab is null, only the 45-px strip remains.
 *
 * Width: a 5 px handle on the panel's left edge drags the panel width (one
 * width for every panel, saved). 200 px at least; dragged under 50 px the
 * panel closes, dragged back out it opens again; the chart area keeps
 * 300 px, so the panel narrows with a small window and hides when even
 * 200 px do not fit.
 */
import { Match, Show, Switch, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { RightRailTabs } from "./RightRailTabs";
import { Watchlist } from "./Watchlist";
import { WatchlistDetail } from "./WatchlistDetail";
import { ObjectTreePanel } from "./ObjectTreePanel";
import { AlertsPanel } from "./AlertsPanel";
import type { Drawing } from "lightweight-charts-drawing/core/types";
import * as kv from "../../data/kv";

type Props = {
  activeTab: string | null;
  setActiveTab: (id: string | null) => void;
  activeSymbol?: string;
  /** Bare active ticker — drives the watchlist row-selection highlight. */
  activeTicker?: string;
  onSymbolSelect: (fullTicker: string) => void;
  /** Active chart interval — threaded to the watchlist for per-symbol alerts. */
  interval?: string;
  drawings: Drawing[];
  selectedDrawingId: string | null;
  setSelectedDrawingId: (id: string | null) => void;
  updateDrawing: (d: Drawing) => void;
  removeDrawing: (id: string) => void;
  moveDrawing: (id: string, toDisplayIndex: number) => void;
  cloneDrawing: (id: string) => void;
  /** Rail buttons shown pressed without owning the panel (screener). */
  pressedTab?: (id: string) => boolean;
};

const WIDTH_KEY = "ot:rail:width";
const WIDTH_DEFAULT = 331;
const WIDTH_MIN = 200;
/** Dragged narrower than this, the panel closes. */
const CLOSE_UNDER = 50;
/** Width the chart area keeps. */
const CHART_MIN = 300;
const DETAIL_HEIGHT_KEY = "ot:rail:detailHeight";
const DETAIL_COLLAPSED_KEY = "ot:rail:detailCollapsed";
const DETAIL_MIN = 140;
/** Keep the watchlist at least this tall when the detail panel grows. */
const WATCHLIST_MIN = 160;

function loadWidth(): number {
  const n = Number(kv.getItem(WIDTH_KEY));
  return Number.isFinite(n) && n > 0 ? Math.max(WIDTH_MIN, n) : WIDTH_DEFAULT;
}

function loadDetailHeight(): number {
  const n = Number(kv.getItem(DETAIL_HEIGHT_KEY));
  return Number.isFinite(n) && n >= DETAIL_MIN ? n : 246;
}

export function RightRail(props: Props) {
  // Resizable detail panel: the watchlist flexes to fill, the detail holds a
  // persisted fixed height, and the divider between them drags to adjust it.
  // The details render as an accordion — collapsing leaves a 48px header.
  const [detailHeight, setDetailHeight] = createSignal<number>(loadDetailHeight());
  const [detailCollapsed, setDetailCollapsed] = createSignal(kv.getItem(DETAIL_COLLAPSED_KEY) === "1");
  let stackRef: HTMLDivElement | undefined;
  createEffect(() => {
    try {
      kv.setItem(DETAIL_HEIGHT_KEY, String(Math.round(detailHeight())));
      kv.setItem(DETAIL_COLLAPSED_KEY, detailCollapsed() ? "1" : "0");
    } catch {
      /* best-effort */
    }
  });

  function beginDetailResize(e: MouseEvent) {
    e.preventDefault();
    const startY = e.clientY;
    const startH = detailHeight();
    // Drag UP grows the detail (it sits below the divider); cap so the
    // watchlist keeps a usable minimum.
    const maxH = Math.max(DETAIL_MIN, (stackRef?.clientHeight ?? 0) - WATCHLIST_MIN);
    const onMove = (ev: MouseEvent) =>
      setDetailHeight(Math.min(maxH, Math.max(DETAIL_MIN, startH + (startY - ev.clientY))));
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = "row-resize";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  // ── Panel width ─────────────────────────────────────────────────────────
  const [width, setWidth] = createSignal(loadWidth());
  // Width left for the panel next to the chart area (Infinity until measured).
  const [room, setRoom] = createSignal(Infinity);
  let containerRef: HTMLDivElement | undefined;
  let tabsWidth = 45;
  // Panel reopened by a drag out of the closed state: the last one shown.
  let lastTab = props.activeTab ?? "base";
  createEffect(() => {
    if (props.activeTab) lastTab = props.activeTab;
  });
  const shownWidth = () => Math.min(width(), room());
  const fits = () => room() >= WIDTH_MIN;
  /** Chart area + panel: what the two share. */
  const shared = () => {
    const c = containerRef;
    const chart = c?.previousElementSibling as HTMLElement | null;
    if (!c || !chart) return Infinity;
    tabsWidth = (c.querySelector(".right-rail-tabs") as HTMLElement | null)?.offsetWidth ?? tabsWidth;
    return chart.offsetWidth + c.offsetWidth - tabsWidth;
  };
  onMount(() => {
    const row = containerRef?.parentElement;
    if (!row) return;
    const measure = () => setRoom(shared() - CHART_MIN);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(row);
    onCleanup(() => ro.disconnect());
  });
  function beginWidthResize(e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startW = props.activeTab && fits() ? shownWidth() : 0;
    const max = Math.max(WIDTH_MIN, shared() - CHART_MIN);
    const onMove = (ev: PointerEvent) => {
      const w = startW - (ev.clientX - startX);
      if (w < CLOSE_UNDER) {
        if (props.activeTab) props.setActiveTab(null);
        return;
      }
      setWidth(Math.min(max, Math.max(WIDTH_MIN, w)));
      if (!props.activeTab) props.setActiveTab(lastTab);
    };
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      document.body.style.cursor = "";
      try {
        kv.setItem(WIDTH_KEY, String(Math.round(width())));
      } catch {
        /* best-effort */
      }
    };
    document.body.style.cursor = "ew-resize";
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  }

  return (
    <div
      ref={containerRef}
      class="right-rail-container"
      style={{ display: "flex", "flex-direction": "row", position: "relative", "--ot-rail-width": `${shownWidth()}px` }}
    >
      <div class="rail-width-handle" role="separator" aria-orientation="vertical" onPointerDown={beginWidthResize} />
      <Show when={props.activeTab && fits()}>
        <Switch>
          <Match when={props.activeTab === "base"}>
            <div
              ref={stackRef}
              class="right-rail-base-stack"
              style={{
                display: "flex",
                "flex-direction": "column",
                height: "100%",
                "min-height": 0,
                // Pin the width so async detail data can never balloon the rail
                // and shove the chart pane left (the rail width + flex-shrink:0).
                width: "var(--ot-rail-width, 331px)",
                "flex-shrink": 0,
                overflow: "hidden",
              }}
            >
              <Watchlist activeSymbol={props.activeSymbol} activeTicker={props.activeTicker} onSymbolSelect={props.onSymbolSelect} interval={props.interval} />
              <Show when={!detailCollapsed()}>
                <div class="rail-detail-resizer" onMouseDown={beginDetailResize} title="Resize" role="separator" aria-orientation="horizontal" />
              </Show>
              <WatchlistDetail
                activeSymbol={props.activeSymbol}
                height={detailHeight()}
                collapsed={detailCollapsed()}
                onToggleCollapse={() => setDetailCollapsed((c) => !c)}
              />
            </div>
          </Match>
          <Match when={props.activeTab === "object_tree"}>
            <ObjectTreePanel
              drawings={props.drawings}
              selectedId={props.selectedDrawingId}
              setSelectedId={props.setSelectedDrawingId}
              onUpdate={props.updateDrawing}
              onRemove={props.removeDrawing}
              onMove={props.moveDrawing}
              onClone={props.cloneDrawing}
            />
          </Match>
          <Match when={props.activeTab === "alerts"}>
            <AlertsPanel symbol={props.activeSymbol} interval={props.interval} />
          </Match>
        </Switch>
      </Show>
      <RightRailTabs active={props.activeTab} setActive={props.setActiveTab} pressed={props.pressedTab} />
    </div>
  );
}
