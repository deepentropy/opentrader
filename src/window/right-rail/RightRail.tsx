/*
 * RightRail — container that pairs the vertical tab strip with the active
 * panel. Panel sits to the LEFT of the strip. When
 * activeTab is null, only the 45-px strip remains.
 */
import { Match, Show, Switch, createEffect, createSignal } from "solid-js";
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
  indicators: string[];
  onRemoveIndicator: (id: string) => void;
  chartSource?: string;
  cloneDrawing: (id: string) => void;
  /** Rail buttons shown pressed without owning the panel (screener). */
  pressedTab?: (id: string) => boolean;
};

const DETAIL_HEIGHT_KEY = "ot:rail:detailHeight";
const DETAIL_COLLAPSED_KEY = "ot:rail:detailCollapsed";
const DETAIL_MIN = 140;
/** Keep the watchlist at least this tall when the detail panel grows. */
const WATCHLIST_MIN = 160;

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

  return (
    <div class="right-rail-container" style={{ display: "flex", "flex-direction": "row" }}>
      <Show when={props.activeTab}>
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
                // and shove the chart pane left (mock's `.right-rail-watchlist-pane`
                // uses a hard 331px width + flex-shrink:0).
                width: "331px",
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
              indicators={props.indicators}
              onRemoveIndicator={props.onRemoveIndicator}
              chartSource={props.chartSource}
              onClone={props.cloneDrawing}
            />
          </Match>
          <Match when={props.activeTab === "alerts"}>
            <AlertsPanel />
          </Match>
        </Switch>
      </Show>
      <RightRailTabs active={props.activeTab} setActive={props.setActiveTab} pressed={props.pressedTab} />
    </div>
  );
}
