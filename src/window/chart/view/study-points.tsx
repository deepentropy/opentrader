/*
 * The points of a study's time and price inputs on the chart, dragged to change them (reference "study inputs"
 * views): an anchor per point while the study is selected or hovered; with the study selected, the grey line of a
 * lone time (vertical) or price (horizontal) input and the axis labels of its values. A time and a price of one
 * inline row are one anchor moved both ways; a lone time's anchor sits halfway down its pane and moves sideways, a
 * lone price's halfway across and moves up and down; its line can be dragged too. A drag is one undo step; a time
 * snaps to the bar under the pointer, a price is the price at the pointer on the study's scale.
 */
import { For, Show, createEffect, createMemo, createSignal, onCleanup, untrack, type JSX } from "solid-js";
import type { ISeriesApi, MouseEventParams, SeriesType, Time } from "lightweight-charts";
import { translate, translateWith } from "../../../i18n/translator";
import { getIndicatorEntry } from "../indicators/registry";
import { isTransformType } from "../chart-types";
import { pointItems, type PointInput, type PointItem } from "../point-request";
import type { ChartCx } from "./context";

/** What createStudyPoints adds to the chart context. */
export interface StudyPointsApi {
  StudyPointsLayer: () => JSX.Element;
}

/** The grey of the lines and axis labels (reference cold-gray-500). */
const GREY = "#787B86";

type Placed = {
  key: string;
  item: PointItem;
  x: number;
  y: number;
  /** The anchor moves: both ways, sideways (time) or up and down (price). */
  dir: "both" | "x" | "y";
  /** The line of a lone input (selected study only). */
  vline?: { x: number; top: number; height: number };
  hline?: { y: number; left: number; width: number };
  /** Axis labels of its values (selected study only). */
  priceLabel?: { y: number; text: string };
  timeLabel?: { x: number; text: string };
};

export function createStudyPoints(cx: ChartCx): StudyPointsApi {
  const { props } = cx;

  // The study under the pointer (its plot hovered), kept while the pointer is on one of its anchors.
  const [hovered, setHovered] = createSignal<string | null>(null);
  const [overAnchor, setOverAnchor] = createSignal<string | null>(null);
  createEffect(() => {
    cx.chartReady();
    const chart = cx.chart;
    if (!chart) return;
    const onMove = (param: MouseEventParams<Time>) => {
      const s = (param.hoveredInfo?.series ?? param.hoveredSeries) as ISeriesApi<SeriesType> | undefined;
      setHovered(param.point && s ? cx.studyOfSeries(s) : null);
    };
    chart.subscribeCrosshairMove(onMove);
    onCleanup(() => chart.unsubscribeCrosshairMove(onMove));
  });

  /** Bumped when the view scrolls or zooms, or the chart resizes (the points follow). */
  const [viewEpoch, setViewEpoch] = createSignal(0);
  createEffect(() => {
    cx.chartReady();
    const ts = cx.chart?.timeScale();
    if (!ts) return;
    const bump = () => setViewEpoch((n) => n + 1);
    ts.subscribeVisibleLogicalRangeChange(bump);
    ts.subscribeSizeChange(bump);
    const ro = new ResizeObserver(bump);
    ro.observe(cx.host);
    onCleanup(() => {
      ts.unsubscribeVisibleLogicalRangeChange(bump);
      ts.unsubscribeSizeChange(bump);
      ro.disconnect();
    });
  });

  /** A drag in progress: the study, its values as dragged so far, its undo step. */
  const [drag, setDrag] = createSignal<{ id: string; values: Record<string, number>; coalesce: string } | null>(null);
  let dragSeq = 0;

  /** The studies whose points show: the selected one (with lines and labels) and the hovered one. */
  const shown = createMemo(() => {
    if (props.shown === false || isTransformType(props.chartType ?? "candle")) return [];
    const sel = cx.selectedStudy();
    const out: { id: string; selected: boolean }[] = [];
    if (sel) out.push({ id: sel, selected: true });
    const hov = overAnchor() ?? hovered() ?? drag()?.id ?? null;
    if (hov && hov !== sel) out.push({ id: hov, selected: false });
    return out.filter((s) => pointItems(configOf(s.id)).length > 0);
  });

  const configOf = (id: string): PointInput[] => (getIndicatorEntry(id)?.inputConfig ?? []) as PointInput[];

  /** The study's pane box in the chart's box, its plot's left edge and width, the series on its scale. */
  const paneOfStudy = (id: string) => {
    const chart = cx.chart;
    if (!chart) return null;
    const pane = cx.controller?.paneOf(id) ?? cx.mainPane();
    const el = chart.panes()[pane]?.getHTMLElement();
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const h = cx.host.getBoundingClientRect();
    const series = cx.controller?.studySeries(id) ?? (pane === cx.mainPane() ? cx.series : null);
    if (!series) return null;
    return { top: r.top - h.top, height: r.height, left: cx.leftAxisWidth(), width: chart.timeScale().width(), series };
  };

  /** The x of a time (ms): the bar at or nearest to it. */
  const timeX = (ms: number): number | null => {
    const ts = cx.chart?.timeScale();
    if (!ts) return null;
    const idx = ts.timeToIndex(Math.floor(ms / 1000) as Time, true);
    if (idx === null) return null;
    const x = ts.logicalToCoordinate(idx as never);
    return x === null ? null : cx.leftAxisWidth() + x;
  };

  const timeText = (ms: number): string => {
    const fmt = cx.chart?.options().localization.timeFormatter;
    const t = Math.floor(ms / 1000);
    return fmt ? fmt(t as Time) : String(t);
  };

  /** The current inputs of a study, with the values of a drag in progress over them. */
  const inputsOf = (id: string): Record<string, unknown> => {
    void props.indicatorSettings?.[id];
    const d = drag();
    return { ...(cx.controller?.getInputs(id) ?? {}), ...(d && d.id === id ? d.values : {}) };
  };

  const placedOf = (id: string, selected: boolean): Placed[] => {
    viewEpoch();
    const box = paneOfStudy(id);
    if (!box) return [];
    const values = inputsOf(id);
    const fmt = box.series.priceFormatter();
    const out: Placed[] = [];
    pointItems(configOf(id)).forEach((item, i) => {
      if (item.kind === "all") {
        const t = Number(values[item.time.id]);
        const p = Number(values[item.price.id]);
        const x = Number.isFinite(t) ? timeX(t) : null;
        const y = Number.isFinite(p) ? box.series.priceToCoordinate(p) : null;
        if (x === null || y === null) return;
        out.push({
          key: `${id}:${i}`, item, x, y: box.top + y, dir: "both",
          ...(selected ? { priceLabel: { y: box.top + y, text: fmt.format(p) }, timeLabel: { x, text: timeText(t) } } : {}),
        });
      } else if (item.kind === "time") {
        const t = Number(values[item.input.id]);
        const x = Number.isFinite(t) ? timeX(t) : null;
        if (x === null) return;
        out.push({
          key: `${id}:${i}`, item, x, y: box.top + box.height / 2, dir: "x",
          ...(selected ? { vline: { x, top: box.top, height: box.height }, timeLabel: { x, text: timeText(t) } } : {}),
        });
      } else {
        const p = Number(values[item.input.id]);
        const y = Number.isFinite(p) ? box.series.priceToCoordinate(p) : null;
        if (y === null) return;
        out.push({
          key: `${id}:${i}`, item, x: box.left + box.width / 2, y: box.top + y, dir: "y",
          ...(selected ? { hline: { y: box.top + y, left: box.left, width: box.width }, priceLabel: { y: box.top + y, text: fmt.format(p) } } : {}),
        });
      }
    });
    return out;
  };

  /** The values a pointer at (x, y) (chart box) gives the dragged point. */
  const valuesAt = (id: string, item: PointItem, x: number, y: number): Record<string, number> => {
    const out: Record<string, number> = {};
    const box = paneOfStudy(id);
    const ts = cx.chart?.timeScale();
    if (!box || !ts) return out;
    const wantsTime = item.kind !== "price";
    const wantsPrice = item.kind !== "time";
    if (wantsTime && cx.raw.length) {
      const logical = ts.coordinateToLogical(x - box.left);
      const first = ts.timeToIndex(cx.raw[0].time as Time, true);
      if (logical !== null && first !== null) {
        const idx = Math.max(first, Math.round(logical));
        const bx = ts.logicalToCoordinate(idx as never);
        const time = bx === null ? null : ts.coordinateToTime(bx);
        if (time !== null) out[item.kind === "all" ? item.time.id : item.input.id] = (time as number) * 1000;
      }
    }
    if (wantsPrice) {
      const price = box.series.coordinateToPrice(y - box.top);
      if (price !== null) out[item.kind === "all" ? item.price.id : item.input.id] = price;
    }
    return out;
  };

  /** Write the dragged values into the study (one undo step per drag). */
  let pending = 0;
  const commit = () => {
    pending = 0;
    const d = untrack(drag);
    if (!d) return;
    const saved = props.indicatorSettings?.[d.id]?.inputs ?? {};
    const name = getIndicatorEntry(d.id)?.name ?? d.id;
    cx.edits.editStudySettings(d.id, { inputs: { ...saved, ...d.values } }, translateWith("change {0} properties", translate(name)), { coalesce: d.coalesce });
  };

  const startDrag = (e: PointerEvent, id: string, item: PointItem) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    if (cx.selectedStudy() !== id) cx.selectStudy(id);
    // Window listeners: the anchor is drawn again at each new position (a captured element would be gone).
    setDrag({ id, values: {}, coalesce: `study-points:${id}:${++dragSeq}` });
    const box = () => cx.host.getBoundingClientRect();
    const move = (ev: PointerEvent) => {
      const b = box();
      const v = valuesAt(id, item, ev.clientX - b.left, ev.clientY - b.top);
      const cur = untrack(drag);
      if (!cur) return;
      if (Object.entries(v).every(([k, n]) => cur.values[k] === n)) return;
      setDrag({ ...cur, values: { ...cur.values, ...v } });
      // The study runs again as the values change: at most every 120 ms during the drag.
      if (!pending) pending = window.setTimeout(commit, 120);
    };
    const end = () => {
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", end, true);
      window.removeEventListener("pointercancel", end, true);
      if (pending) window.clearTimeout(pending);
      commit();
      setDrag(null);
    };
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", end, true);
    window.addEventListener("pointercancel", end, true);
  };

  const cursorOf = (dir: Placed["dir"]) => (dir === "x" ? "ew-resize" : dir === "y" ? "ns-resize" : "move");

  const StudyPointsLayer = () => (
    <For each={shown()}>
      {(s) => {
        const placed = createMemo(() => placedOf(s.id, s.selected));
        return (
          <For each={placed()}>
            {(p) => {
              const grab = (e: PointerEvent) => startDrag(e, s.id, p.item);
              return (
                <>
                  <Show when={p.vline}>
                    {(l) => (
                      <div class="ot-study-point__vline" style={{ left: `${Math.round(l().x) - 3}px`, top: `${l().top}px`, height: `${l().height}px` }} onPointerDown={grab}>
                        <span style={{ background: GREY }} />
                      </div>
                    )}
                  </Show>
                  <Show when={p.hline}>
                    {(l) => (
                      <div class="ot-study-point__hline" style={{ top: `${Math.round(l().y) - 3}px`, left: `${l().left}px`, width: `${l().width}px` }} onPointerDown={grab}>
                        <span style={{ background: GREY }} />
                      </div>
                    )}
                  </Show>
                  <div
                    class="ot-study-point__anchor"
                    classList={{ "is-dragging": drag()?.id === s.id }}
                    style={{ left: `${p.x}px`, top: `${p.y}px`, cursor: cursorOf(p.dir) }}
                    onPointerEnter={() => setOverAnchor(s.id)}
                    onPointerLeave={() => setOverAnchor(null)}
                    onPointerDown={grab}
                  />
                  <Show when={p.priceLabel}>
                    {(l) => (
                      <div class="ot-study-point__price ot-value" data-no-translate style={{ top: `${l().y}px`, left: `${cx.leftAxisWidth() + (cx.chart?.timeScale().width() ?? 0)}px`, background: GREY }}>
                        {l().text}
                      </div>
                    )}
                  </Show>
                  <Show when={p.timeLabel}>
                    {(l) => (
                      <div class="ot-study-point__time ot-value" data-no-translate style={{ left: `${l().x}px`, top: `${cx.host.clientHeight - (cx.chart?.timeScale().height() ?? 0)}px`, background: GREY }}>
                        {l().text}
                      </div>
                    )}
                  </Show>
                </>
              );
            }}
          </For>
        );
      }}
    </For>
  );

  return { StudyPointsLayer };
}
