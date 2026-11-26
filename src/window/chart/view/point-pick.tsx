/*
 * The point asked on this chart for a script's time / price inputs (../point-request.ts): a layer over the chart
 * that follows the pointer (the bar's vertical line for a time, the horizontal line for a price), draws the points
 * already given in grey, and gives the clicked point. The hint sits at the bottom of the chart; Escape or its close
 * button cancels. Wheel zoom and scroll go on to the chart. Only the focused chart of the asking tab takes it.
 */
import { Show, For, createEffect, createMemo, createSignal, onCleanup, type JSX } from "solid-js";
import type { Time } from "lightweight-charts";
import { ChartEventHint } from "../../../components/ChartEventHint";
import { cancelPointRequest, pointRequest, setPickable, type PickedPoint } from "../point-request";
import { forwardWheel } from "./replay";
import { isTransformType } from "../chart-types";
import type { ChartCx } from "./context";

/** The grey of the points already given (reference cold-gray-500). */
const PICKED = "#787B86";

/** What createPointPick adds to the chart context. */
export interface PointPickApi {
  PointPickLayer: () => JSX.Element;
}

export function createPointPick(cx: ChartCx): PointPickApi {
  const { props } = cx;
  const request = () => {
    const r = pointRequest();
    return r && r.tabId === props.tabId && r.paneIndex === props.paneIndex && props.shown !== false && !isTransformType(props.chartType ?? "candle") ? r : null;
  };

  // This chart can take points while it is shown with time-based bars.
  createEffect(() => {
    const target = { tabId: props.tabId, paneIndex: props.paneIndex };
    setPickable(target, props.shown !== false && !isTransformType(props.chartType ?? "candle"));
    onCleanup(() => setPickable(target, false));
  });

  // Escape cancels the sequence (before the chart's own keys).
  createEffect(() => {
    if (!request()) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      cancelPointRequest();
    };
    window.addEventListener("keydown", onKey, true);
    onCleanup(() => window.removeEventListener("keydown", onKey, true));
  });

  /** Bumped when the view scrolls / zooms (the lines follow their bars). */
  const [viewEpoch, setViewEpoch] = createSignal(0);
  createEffect(() => {
    if (!request()) return;
    cx.chartReady();
    const ts = cx.chart?.timeScale();
    if (!ts) return;
    const bump = () => setViewEpoch((n) => n + 1);
    ts.subscribeVisibleLogicalRangeChange(bump);
    onCleanup(() => ts.unsubscribeVisibleLogicalRangeChange(bump));
  });

  /** The main price pane's top and height in the chart's box. */
  const mainPaneBox = (): { top: number; height: number } | null => {
    const el = cx.chart?.panes()[cx.mainPane()]?.getHTMLElement();
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const h = cx.host.getBoundingClientRect();
    return { top: r.top - h.top, height: r.height };
  };

  /** The point under (x, y) (chart box coordinates): the bar's time (no point left of the first bar), the price on
   *  the main pane's scale (no price off that pane). */
  const pointAt = (x: number, y: number): (PickedPoint & { x?: number; y?: number }) | null => {
    if (!cx.chart || !cx.series || cx.raw.length === 0) return null;
    const ts = cx.chart.timeScale();
    const left = cx.leftAxisWidth();
    const logical = ts.coordinateToLogical(Math.max(0, Math.min(ts.width() - 1, x - left)));
    const first = ts.timeToIndex(cx.raw[0].time as Time, true);
    const out: PickedPoint & { x?: number; y?: number } = {};
    if (logical !== null && first !== null) {
      const idx = Math.round(logical);
      const bx = ts.logicalToCoordinate(idx as never);
      const time = idx >= first && bx !== null ? ts.coordinateToTime(bx) : null;
      if (time !== null && bx !== null) {
        out.time = time as number;
        out.x = left + bx;
      }
    }
    const box = mainPaneBox();
    if (box && y >= box.top && y < box.top + box.height) {
      const price = cx.series.coordinateToPrice(y - box.top);
      if (price !== null) {
        out.price = price;
        out.y = y;
      }
    }
    return out;
  };

  const [hover, setHover] = createSignal<{ x: number; y: number } | null>(null);
  createEffect(() => {
    if (!request()) setHover(null);
  });

  /** What the pointer would set now, and where its lines go. */
  const live = createMemo(() => {
    const r = request();
    const h = hover();
    viewEpoch();
    if (!r || !h) return null;
    const p = pointAt(h.x, h.y);
    if (!p) return null;
    return {
      x: r.kind !== "price" ? p.x : undefined,
      y: r.kind !== "time" ? p.y : undefined,
    };
  });

  /** The points already given, where they are now. */
  const picked = createMemo(() => {
    const r = request();
    viewEpoch();
    hover();
    if (!r || !cx.chart || !cx.series) return [];
    const ts = cx.chart.timeScale();
    const box = mainPaneBox();
    const left = cx.leftAxisWidth();
    return r.picked.map((p) => {
      const x = p.time !== undefined ? ts.timeToCoordinate(p.time as Time) : null;
      const yy = p.price !== undefined ? cx.series!.priceToCoordinate(p.price) : null;
      return { x: x === null ? undefined : left + x, y: yy === null || !box ? undefined : box.top + yy };
    });
  });

  const height = () => mainPaneBox()?.height ?? cx.host.clientHeight;
  /** The plot's left edge and width (the price axes left out). */
  const plotLeft = () => cx.leftAxisWidth();
  const plotWidth = () => cx.chart?.timeScale().width() ?? 0;
  const top = () => mainPaneBox()?.top ?? 0;

  const PointPickLayer = () => (
    <Show when={request()}>
      {(r) => (
        <>
          <div
            class="ot-point-pick"
            data-name="point-pick-layer"
            onPointerMove={(e) => {
              const b = cx.host.getBoundingClientRect();
              setHover({ x: e.clientX - b.left, y: e.clientY - b.top });
            }}
            onPointerLeave={() => setHover(null)}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              const b = cx.host.getBoundingClientRect();
              const p = pointAt(e.clientX - b.left, e.clientY - b.top);
              if (!p) return;
              const kind = r().kind;
              if ((kind !== "price" && p.time === undefined) || (kind !== "time" && p.price === undefined)) return;
              r().resolve({ ...(kind !== "price" ? { time: p.time } : {}), ...(kind !== "time" ? { price: p.price } : {}) });
            }}
            onWheel={(e) => forwardWheel(e, cx.host)}
          >
            <For each={picked()}>
              {(p) => (
                <>
                  <Show when={p.x !== undefined}>
                    <div class="ot-point-pick__vline" style={{ left: `${Math.round(p.x!)}px`, top: `${top()}px`, height: `${height()}px`, background: PICKED }} />
                  </Show>
                  <Show when={p.y !== undefined}>
                    <div class="ot-point-pick__hline" style={{ top: `${Math.round(p.y!)}px`, left: `${plotLeft()}px`, width: `${plotWidth()}px`, background: PICKED }} />
                  </Show>
                  <Show when={p.x !== undefined && p.y !== undefined}>
                    <div class="ot-point-pick__anchor" style={{ left: `${p.x}px`, top: `${p.y}px`, "border-color": PICKED }} />
                  </Show>
                </>
              )}
            </For>
            <Show when={live()}>
              {(l) => (
                <>
                  <Show when={l().x !== undefined}>
                    <div class="ot-point-pick__vline is-live" style={{ left: `${Math.round(l().x!)}px`, top: `${top()}px`, height: `${height()}px` }} />
                  </Show>
                  <Show when={l().y !== undefined}>
                    <div class="ot-point-pick__hline is-live" style={{ top: `${Math.round(l().y!)}px`, left: `${plotLeft()}px`, width: `${plotWidth()}px` }} />
                  </Show>
                  <Show when={l().x !== undefined && l().y !== undefined}>
                    <div class="ot-point-pick__anchor is-live" style={{ left: `${l().x}px`, top: `${l().y}px` }} />
                  </Show>
                </>
              )}
            </Show>
          </div>
          <ChartEventHint text={r().hint} onClose={() => cancelPointRequest()} />
        </>
      )}
    </Show>
  );

  return { PointPickLayer };
}
