/*
 * Price scales of a chart view (scales/scale-layout.ts): which scale each
 * source is on, the extra axes past the first one of a side (painted on the
 * library's side axis by scales/extra-axes.ts), their mouse strips (drag =
 * scale, double click = auto scale, right click = the scale's menu) and the
 * scale names under the axes.
 *
 * Reference rules (its axis stubs): once the chart has two scales or more,
 * the time axis row shows each scale's name in a circle under its axis
 * (11 px text, 19 px circle at half opacity; dark #2E2E2E / grey text, light
 * #EBEBEB / #575757) while the chart is the active or the hovered one; a
 * hovered name turns into the gear, its axis is tinted; click = the scale's
 * menu; tooltip = the sources on the scale.
 */
import { For, Show, createSignal, onCleanup } from "solid-js";
import type { ISeriesApi, MouseEventParams, SeriesType, Time } from "lightweight-charts";
import { Tooltip } from "../../../components/Tooltip";
import { splitSymbol } from "../../../data/datafeed";
import { readChartTokens } from "../chart-tokens";
import { isDarkColor } from "../history-end-marker";
import { getIndicatorEntry } from "../indicators/registry";
import { typeIdOf } from "../indicators/study-id";
import { MAIN_SOURCE_ID } from "../object-tree-sources";
import type { CompareEntry } from "../../shell/tabs";
import { ScaleLayout, isScaleKey, keySide, scaleLetter, type ScaleKey, type ScaleUse, type Side } from "../scales/scale-layout";
import { ExtraAxesPrimitive, ExtraScaleModel, axisWidthFor, isExtraScaleId, setFirstAxisWidths, type AxisStyle } from "../scales/extra-axes";
import { type ChartCx } from "./context";
import type { JSX } from "solid-js";

/** A target of the price scale menu that is not the main series' scale. */
export type ScaleTarget = { pane: number; libId: string; key: ScaleKey };

/** What createScales adds to the chart context. */
export interface ScalesApi {
  /** The chart's scales now. */
  scaleLayout: () => ScaleLayout;
  /** Scale of a study: the key given to a "new" request and its library id; null = no room (no scale). */
  scaleResolve: (id: string, pane: number, key: ScaleKey | "new") => { key: ScaleKey; lib: string } | null;
  /** Library scale id of a compared symbol (hidden "cmp:<id>" = no scale). */
  compareScaleId: (e: CompareEntry, pane: number) => string;
  /** The sources changed scales: persist given scales, re-apply the scale ids, repaint the axes (batched). */
  syncScaleLayout: () => void;
  /** Titles of the sources on a scale (tooltips). */
  scaleTitles: (pane: number, key: ScaleKey) => string[];
  /** Move every source of scale `key` to a new scale of `side` ("Move scale to left / right"). */
  moveScaleToSide: (pane: number, key: ScaleKey, side: Side) => void;
  /** Width of the first axis of a side (the whole axis without extra scales). */
  firstAxisWidthOf: (side: Side) => number;
  /** The chart has two scales or more (scale names shown). */
  namedScales: () => boolean;
  ExtraAxisOverlays: () => JSX.Element;
}

type Strip = { k: string; pane: number; side: Side; index: number; libId: string; key: ScaleKey; x: number; top: number; w: number; h: number };
type Stub = { k: string; side: Side; index: number; x: number; w: number; letter: string; pane: number; key: ScaleKey | null };

export function createScales(cx: ChartCx): ScalesApi {
  const { props } = cx;

  /** Scale uses of a compared symbol (null: no scale / not drawn). */
  function compareUse(e: CompareEntry): ScaleUse | null {
    const main = cx.mainPane();
    if (e.placement === "none") return null;
    if (e.placement === "percent") {
      const k = cx.seriesKey();
      return { source: e.id, pane: main, key: k === "none" ? cx.mainSide() : k };
    }
    if (e.placement === "scale") return { source: e.id, pane: main, key: e.scale ?? "new" };
    if (e.paneScale === "none") return null;
    const layer = cx.compareLayers.get(e.id);
    if (!layer) return null;
    return { source: e.id, pane: layer.paneIndex, key: e.paneScale ?? cx.currentTokens().scalesPlacement };
  }

  function scaleLayout(): ScaleLayout {
    const sk = cx.seriesKey();
    const uses: ScaleUse[] = sk === "none" ? [] : [{ source: MAIN_SOURCE_ID, pane: cx.mainPane(), key: sk }];
    if (cx.controller) uses.push(...cx.controller.scaleUses());
    for (const e of cx.compareEntries()) {
      const u = compareUse(e);
      if (u) uses.push(u);
    }
    return new ScaleLayout(uses, cx.currentTokens().scalesMode);
  }

  function scaleResolve(id: string, pane: number, key: ScaleKey | "new"): { key: ScaleKey; lib: string } | null {
    const lay = scaleLayout();
    const k = key === "new" ? lay.given.get(id) ?? lay.sourceScale(id)?.key ?? null : key;
    if (!k) return null;
    return { key: k, lib: lay.libId(pane, k) };
  }

  function compareScaleId(e: CompareEntry, pane: number): string {
    const u = compareUse(e);
    if (!u) {
      if (e.placement === "pane" && e.paneScale !== "none") return e.paneScale ?? cx.currentTokens().scalesPlacement;
      return `cmp:${e.id}`;
    }
    const lay = scaleLayout();
    const key = u.key === "new" ? lay.given.get(e.id) ?? null : u.key;
    return key ? lay.libId(pane, key) : `cmp:${e.id}`;
  }

  function scaleTitles(pane: number, key: ScaleKey): string[] {
    const lay = scaleLayout();
    const out: string[] = [];
    for (const src of lay.sourcesOn(pane, key)) {
      if (src === MAIN_SOURCE_ID) {
        const { ticker, exchange } = splitSymbol(props.symbol ?? "");
        out.push(`${exchange ? `${ticker} · ${exchange}` : ticker}, ${props.interval ?? "1D"}`);
        continue;
      }
      const cmp = cx.compareEntry(src);
      if (cmp) { out.push(cx.compareTitle(cmp)); continue; }
      const entry = getIndicatorEntry(typeIdOf(src));
      if (entry) out.push(entry.shortName ?? entry.name);
    }
    return out;
  }

  // ── Persist given scales, re-apply the ids when the layout changed ────
  let lastSig = "";
  let syncQueued = false;
  function syncScaleLayout() {
    if (syncQueued) return;
    syncQueued = true;
    queueMicrotask(() => {
      syncQueued = false;
      runSync();
    });
  }
  function runSync() {
    const chart = cx.chart;
    const c = cx.controller;
    if (!chart) return;
    const lay = scaleLayout();
    // Scales given to "new" requests are kept (reference: a source keeps its scale).
    for (const [src, key] of lay.given) {
      if (!key) continue;
      const cmp = cx.compareEntry(src);
      if (cmp) {
        if (cmp.placement === "scale" && !cmp.scale) props.onCompareChange?.(src, { scale: key });
        continue;
      }
      if (!c) continue;
      const options = c.setScaleKey(src, key);
      if (options) props.onIndicatorSettings?.(src, { inputs: c.getInputs(src) ?? {}, styles: c.getStyles(src) ?? {}, options });
    }
    const sig = lay.signature();
    if (sig !== lastSig) {
      lastSig = sig;
      firstBoost = { left: 0, right: 0 };
      cx.applySeriesScale();
      c?.redrawAll();
      cx.syncCompare();
    }
    cx.syncScaleSides();
    updateAxes(lay);
  }

  // ── Extra axes ──────────────────────────────────────────────────────────
  const prims = new Map<string, { prim: ExtraAxesPrimitive; series: ISeriesApi<SeriesType>; pane: number }>();
  /** Width of each index per side (index 0 = the library's axis). */
  let widths: Record<Side, number[]> = { left: [], right: [] };
  let appliedMin: Record<Side, number> = { left: 0, right: 0 };
  /** When the minimum width last changed (the library lays out on its next frame). */
  const minChangedAt: Record<Side, number> = { left: 0, right: 0 };
  /** The library's first axis came out wider than measured (its own text measures). */
  let firstBoost: Record<Side, number> = { left: 0, right: 0 };
  let layoutNow: ScaleLayout | null = null;

  const axisStyle = (): AxisStyle => {
    const t = cx.currentTokens();
    const o = cx.chart?.options();
    const fs = o?.layout.fontSize ?? t.scaleFontSize;
    const family = o?.layout.fontFamily ?? "sans-serif";
    return {
      font: `${fs}px ${family}`,
      fontSize: fs,
      textColor: o?.layout.textColor ?? t.scaleTextColor,
      borderColor: o?.rightPriceScale.borderColor ?? t.scaleLinesColor,
      borderVisible: o?.rightPriceScale.borderVisible !== false,
      crosshairBg: o?.crosshair.horzLine.labelBackgroundColor ?? t.crosshairLabelBg,
      crosshairVisible: o?.crosshair.horzLine.labelVisible !== false,
    };
  };

  function updateAxes(lay: ScaleLayout) {
    const chart = cx.chart;
    if (!chart) return;
    layoutNow = lay;
    const groups = new Map<string, { pane: number; side: Side; models: ExtraScaleModel[] }>();
    for (const x of lay.extraScales()) {
      const k = `${x.pane}|${x.side}`;
      let g = groups.get(k);
      if (!g) groups.set(k, (g = { pane: x.pane, side: x.side, models: [] }));
      const old = prims.get(k)?.prim.scales.find((m) => m.scale.index === x.index && m.scale.libId === `${x.side}#${x.index}`);
      g.models.push(old ?? new ExtraScaleModel(chart, { pane: x.pane, side: x.side, index: x.index, libId: `${x.side}#${x.index}` }));
    }
    for (const [k, p] of prims) {
      const g = groups.get(k);
      const anchor = g ? anchorSeries(g.pane, g.side) : null;
      if (!g || anchor !== p.series) {
        try { p.series.detachPrimitive(p.prim); } catch { /* series gone */ }
        prims.delete(k);
      }
    }
    for (const [k, g] of groups) {
      let p = prims.get(k);
      if (!p) {
        const anchor = anchorSeries(g.pane, g.side);
        if (!anchor) continue;
        const prim = new ExtraAxesPrimitive(g.side, axisStyle);
        prim.onUpdate = scheduleMeasure;
        anchor.attachPrimitive(prim as never);
        p = { prim, series: anchor, pane: g.pane };
        prims.set(k, p);
      }
      p.prim.scales = g.models;
    }
    measure();
  }

  /** A series on the library's side scale of a pane (the extra axes are painted on that axis). */
  function anchorSeries(pane: number, side: Side): ISeriesApi<SeriesType> | null {
    const p = cx.chart?.panes()[pane];
    if (!p) return null;
    return p.getSeries().find((s) => (s.options() as { priceScaleId?: string }).priceScaleId === side) ?? null;
  }

  let measureQueued = false;
  function scheduleMeasure() {
    if (measureQueued) return;
    measureQueued = true;
    requestAnimationFrame(() => {
      measureQueued = false;
      measure();
    });
  }

  let measureCtx: CanvasRenderingContext2D | null = null;
  function textWidth(texts: string[], font: string): number {
    if (!measureCtx) measureCtx = document.createElement("canvas").getContext("2d");
    if (!measureCtx) return 0;
    measureCtx.font = font;
    let w = 0;
    for (const t of texts) w = Math.max(w, measureCtx.measureText(t).width);
    return w;
  }

  /** Width the library gives its side axis of pane `pane` (its rule on its texts). */
  function firstWidthOf(pane: number, side: Side, st: AxisStyle): number {
    const chart = cx.chart!;
    const p = chart.panes()[pane];
    if (!p) return 0;
    const h = chart.paneSize(pane).height;
    const all = p.getSeries();
    const on = all.filter((s) => (s.options() as { priceScaleId?: string }).priceScaleId === side);
    const lead = (cx.series && on.includes(cx.series as never) ? (cx.series as unknown as ISeriesApi<SeriesType>) : null) ?? on[0];
    if (!lead) return 0;
    const model = new ExtraScaleModel(chart, { pane, side, index: 0, libId: side });
    const fmt = model.formatter();
    if (!fmt) return 0;
    const texts: string[] = [];
    const a = lead.coordinateToPrice(1);
    const b = lead.coordinateToPrice(Math.max(1, h - 2));
    if (a != null && b != null) {
      const lo = Math.min(a as number, b as number);
      const hi = Math.max(a as number, b as number);
      texts.push(fmt(lo), fmt(hi), fmt(Math.floor(lo) + 0.11111111111111), fmt(Math.ceil(hi) - 0.11111111111111));
    }
    // Last-value labels drawn on this axis: its series', and the overlay ones' on the chart's default side.
    const def = cx.currentTokens().scalesPlacement;
    for (const s of all) {
      const o = s.options() as { priceScaleId?: string; lastValueVisible?: boolean; visible?: boolean };
      if (!o.lastValueVisible || o.visible === false) continue;
      const id = o.priceScaleId ?? "";
      const here = id === side || (side === def && id !== "left" && id !== "right" && !isExtraScaleId(id));
      if (!here) continue;
      const d = s.data();
      const last = d[d.length - 1] as { value?: number; close?: number } | undefined;
      const v = last?.value ?? last?.close;
      if (v != null) texts.push(fmt(v));
    }
    return axisWidthFor(textWidth(texts, st.font), st.fontSize);
  }

  function measure() {
    const chart = cx.chart;
    const lay = layoutNow;
    if (!chart || !lay) return;
    const st = axisStyle();
    const next: Record<Side, number[]> = { left: [], right: [] };
    const counts = lay.slotCounts();
    for (const side of ["left", "right"] as const) {
      const n = side === "left" ? counts.left : counts.right;
      if (n < 2) continue;
      const arr = new Array<number>(n).fill(0);
      for (let pane = 0; pane < chart.panes().length; pane++) {
        if (lay.scales(pane, side).length) arr[0] = Math.max(arr[0], firstWidthOf(pane, side, st));
      }
      for (const p of prims.values()) {
        if (p.prim.side !== side) continue;
        const h = chart.paneSize(p.pane).height;
        for (const m of p.prim.scales) arr[m.scale.index] = Math.max(arr[m.scale.index], axisWidthFor(textWidth(m.paint(h, st.fontSize).texts, st.font), st.fontSize));
      }
      // The library's first axis is wider than measured: it keeps its width.
      let actual = 0;
      try { actual = chart.priceScale(side).width(); } catch { /* not laid out */ }
      const settled = performance.now() - minChangedAt[side] > 300;
      if (settled && appliedMin[side] > 0 && actual > appliedMin[side] + 1) firstBoost[side] = Math.max(firstBoost[side], actual);
      arr[0] = Math.max(arr[0], firstBoost[side]);
      next[side] = arr;
    }
    widths = next;
    for (const side of ["left", "right"] as const) {
      const min = next[side].length > 1 ? next[side].reduce((a, b) => a + b, 0) : 0;
      if (min !== appliedMin[side]) {
        appliedMin[side] = min;
        minChangedAt[side] = performance.now();
        chart.applyOptions(side === "left" ? { leftPriceScale: { minimumWidth: min } } : { rightPriceScale: { minimumWidth: min } });
      }
    }
    setFirstAxisWidths(chart, { left: next.left.length > 1 ? next.left[0] : 0, right: next.right.length > 1 ? next.right[0] : 0 });
    for (const p of prims.values()) {
      const w = next[p.prim.side];
      if (w.length === p.prim.widths.length && w.every((v, i) => v === p.prim.widths[i])) continue;
      p.prim.widths = w;
      p.prim.update();
    }
    refreshGeometry();
  }

  function firstAxisWidthOf(side: Side): number {
    const w = widths[side];
    if (w.length > 1) return w[0];
    try { return cx.chart?.priceScale(side).width() ?? 0; } catch { return 0; }
  }

  // Crosshair label on the extra axes of the pane under the pointer.
  const onCrosshair = (param: MouseEventParams<Time>) => {
    const y = param.point?.y ?? null;
    const pane = (param as { paneIndex?: number }).paneIndex;
    for (const p of prims.values()) {
      const next = y !== null && pane === p.pane ? y : null;
      if (next !== p.prim.crosshairY) {
        p.prim.crosshairY = next;
        p.prim.update();
      }
    }
  };
  let subscribed: typeof cx.chart = null;
  const subscribeOnce = () => {
    if (!cx.chart || subscribed === cx.chart) return;
    subscribed = cx.chart;
    cx.chart.subscribeCrosshairMove(onCrosshair);
  };
  onCleanup(() => {
    try { subscribed?.unsubscribeCrosshairMove(onCrosshair); } catch { /* chart gone */ }
    for (const p of prims.values()) {
      try { p.series.detachPrimitive(p.prim); } catch { /* series gone */ }
    }
    prims.clear();
  });

  // ── Mouse strips and name stubs ─────────────────────────────────────────
  const [strips, setStrips] = createSignal<Strip[]>([]);
  const [stubs, setStubs] = createSignal<Stub[]>([]);
  const [stubTop, setStubTop] = createSignal(0);
  const [stubH, setStubH] = createSignal(0);
  const [hoverStub, setHoverStub] = createSignal<string | null>(null);

  function sideX(side: Side, index: number): { x: number; w: number } | null {
    const chart = cx.chart;
    if (!chart || !cx.host) return null;
    const ws = widths[side];
    const w = ws.length > 1 ? ws[index] ?? 0 : (() => { try { return chart.priceScale(side).width(); } catch { return 0; } })();
    let off = 0;
    for (let k = 0; k < index; k++) off += ws[k] ?? 0;
    if (side === "left") {
      let total = 0;
      try { total = chart.options().leftPriceScale.visible ? chart.priceScale("left").width() : 0; } catch { /* not laid out */ }
      return { x: total - off - w, w };
    }
    let total = 0;
    try { total = chart.options().rightPriceScale.visible ? chart.priceScale("right").width() : 0; } catch { /* not laid out */ }
    return { x: cx.host.clientWidth - total + off, w };
  }

  function refreshGeometry() {
    const lay = layoutNow;
    if (!lay || !cx.chart) return;
    subscribeOnce();
    const boxes = cx.paneBoxes();
    const out: Strip[] = [];
    for (const x of lay.extraScales()) {
      const box = boxes.find((b) => b.index === x.pane);
      const sx = sideX(x.side, x.index);
      if (!box || !sx || !(sx.w > 0)) continue;
      out.push({ k: `${x.pane}|${x.side}|${x.index}`, pane: x.pane, side: x.side, index: x.index, libId: `${x.side}#${x.index}`, key: x.key, x: sx.x, top: box.top, w: sx.w, h: box.height });
    }
    setStrips((prev) => (JSON.stringify(prev) === JSON.stringify(out) ? prev : out));
    const counts = lay.slotCounts();
    const st: Stub[] = [];
    if (counts.total > 1) {
      for (const side of ["left", "right"] as const) {
        const n = side === "left" ? counts.left : counts.right;
        for (let i = 0; i < n; i++) {
          const sx = sideX(side, i);
          if (!sx || !(sx.w > 0)) continue;
          // The scale of that index in the price pane (else the first pane having one) answers the stub.
          const main = cx.mainPane();
          let pane = main;
          let key: ScaleKey | null = lay.scales(main, side)[i] ?? null;
          if (!key) {
            for (let p = 0; p < cx.chart.panes().length && !key; p++) { const k = lay.scales(p, side)[i]; if (k) { key = k; pane = p; } }
          }
          st.push({ k: `${side}|${i}`, side, index: i, x: sx.x, w: sx.w, letter: scaleLetter(side, i), pane, key });
        }
      }
    }
    setStubs((prev) => (JSON.stringify(prev) === JSON.stringify(st) ? prev : st));
    const last = boxes.reduce((m, b) => Math.max(m, b.top + b.height), 0);
    const th = cx.chart.options().timeScale.visible === false ? 0 : cx.chart.timeScale().height();
    setStubTop(last);
    setStubH(th);
  }

  const namedScales = () => stubs().length > 0;

  function moveScaleToSide(pane: number, key: ScaleKey, side: Side) {
    const lay = scaleLayout();
    const to = lay.newKeyFor(pane, side);
    if (!to) return;
    for (const src of lay.sourcesOn(pane, key)) {
      if (src === MAIN_SOURCE_ID) continue;
      const cmp = cx.compareEntry(src);
      if (cmp) {
        if (cmp.placement === "pane") props.onCompareChange?.(src, { paneScale: to });
        else props.onCompareChange?.(src, { placement: "scale", scale: to });
        continue;
      }
      const c = cx.controller;
      const options = c?.pinToScale(src, to);
      if (c && options) props.onIndicatorSettings?.(src, { inputs: c.getInputs(src) ?? {}, styles: c.getStyles(src) ?? {}, options });
    }
    syncScaleLayout();
  }

  // Strip drag: the library's rule (scale around the range's centre by the
  // ratio of the distances to the axis bottom, 20 % of the height added).
  function onStripDown(e: PointerEvent, s: Strip) {
    if (e.button !== 0 || !cx.chart) return;
    e.preventDefault();
    e.stopPropagation();
    const ps = cx.chart.priceScale(s.libId, s.pane);
    const range = ps.getVisibleRange();
    if (!range) return;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const top = el.getBoundingClientRect().top;
    const startFromBottom = s.h - (e.clientY - top);
    const k = (s.h - 1) * 0.2;
    const centre = (range.from + range.to) / 2;
    const half = (range.to - range.from) / 2;
    const move = (ev: PointerEvent) => {
      const x = Math.max(0, s.h - (ev.clientY - top));
      const coeff = Math.max((startFromBottom + k) / (x + k), 0.1);
      ps.setAutoScale(false);
      ps.setVisibleRange({ from: centre - half * coeff, to: centre + half * coeff });
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  }

  function ExtraAxisOverlays() {
    const dark = () => isDarkColor(readChartTokens(cx.appearance()).bg);
    const shown = () => !!props.active || cx.chartHovered();
    const tint = () => (dark() ? "rgba(46, 46, 46, 0.5)" : "rgba(235, 235, 235, 0.5)");
    return (
      <>
        <For each={strips()}>
          {(s) => (
            <div
              class="ot-extra-axis"
              data-name="extra-price-axis"
              data-scale={s.libId}
              data-pane={s.pane}
              style={{
                left: `${s.x}px`,
                top: `${s.top}px`,
                width: `${s.w}px`,
                height: `${s.h}px`,
                background: hoverStub() === `${s.side}|${s.index}` ? tint() : undefined,
                "mix-blend-mode": hoverStub() === `${s.side}|${s.index}` ? (dark() ? "lighten" : "darken") : undefined,
              }}
              onPointerDown={(e) => onStripDown(e, s)}
              onMouseDown={(e) => e.stopPropagation()}
              onDblClick={(e) => {
                e.stopPropagation();
                cx.chart?.priceScale(s.libId, s.pane).setAutoScale(true);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                cx.openPriceScaleMenu(e, undefined, { pane: s.pane, libId: s.libId, key: s.key });
              }}
            />
          )}
        </For>
        {/* A hovered name over a side's first axis: that axis tinted in every pane having it (the other axes'
            strips tint themselves). */}
        <For each={hoverStub()?.endsWith("|0") ? cx.paneBoxes().filter((b) => layoutNow?.scales(b.index, hoverStub()!.split("|")[0] as Side).length) : []}>
          {(b) => {
            const side = hoverStub()!.split("|")[0] as Side;
            const sx = sideX(side, 0);
            return (
              <Show when={sx}>
                <div
                  class="ot-axis-corner-tint"
                  style={{ left: `${sx!.x}px`, top: `${b.top}px`, width: `${sx!.w}px`, height: `${b.height}px`, background: tint(), "mix-blend-mode": dark() ? "lighten" : "darken" }}
                />
              </Show>
            );
          }}
        </For>
        <Show when={stubH() > 0}>
          <For each={stubs()}>
            {(s) => {
              const hovered = () => hoverStub() === s.k;
              return (
                <Tooltip text={s.key ? scaleTitles(s.pane, s.key).join("\n") : ""} side="top">
                  <div
                    class="ot-axis-stub"
                    data-name="axis-stub"
                    data-letter={s.letter}
                    style={{ left: `${s.x}px`, top: `${stubTop()}px`, width: `${s.w}px`, height: `${stubH()}px`, color: dark() ? "#DBDBDB" : "#0F0F0F" }}
                    onMouseEnter={() => setHoverStub(s.k)}
                    onMouseLeave={() => setHoverStub(null)}
                    onMouseDown={(e) => e.stopPropagation()}
                    onDblClick={(e) => e.stopPropagation()}
                    onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
                    onClick={(e) => {
                      e.stopPropagation();
                      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                      const main = s.pane === cx.mainPane() && s.key === cx.seriesKey();
                      if (main || !s.key) cx.openPriceScaleMenu(e, rect);
                      else cx.openPriceScaleMenu(e, rect, { pane: s.pane, libId: s.index === 0 ? s.side : `${s.side}#${s.index}`, key: s.key });
                    }}
                  >
                    <Show when={shown()}>
                      <Show
                        when={hovered()}
                        fallback={
                          <span
                            class="ot-axis-stub-letter"
                            style={{ background: dark() ? "rgba(46, 46, 46, 0.5)" : "rgba(235, 235, 235, 0.5)", color: dark() ? "#808080" : "#575757" }}
                          >
                            {s.letter}
                          </span>
                        }
                      >
                        <svg viewBox="0 0 15 13" width="15" height="13" aria-hidden="true">
                          <path fill="currentColor" fill-rule="evenodd" d="M4.1 1 1.14 6.5 4.1 12h6.8l2.96-5.5L10.9 1H4.1ZM15 6.5 11.5 0h-8L0 6.5 3.5 13h8L15 6.5ZM7.5 8a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm0 1a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z" />
                        </svg>
                      </Show>
                    </Show>
                  </div>
                </Tooltip>
              );
            }}
          </For>
        </Show>
      </>
    );
  }

  return {
    scaleLayout,
    scaleResolve,
    compareScaleId,
    syncScaleLayout,
    scaleTitles,
    moveScaleToSide,
    firstAxisWidthOf,
    namedScales,
    ExtraAxisOverlays,
  };
}

/** Side of a stored scale key (re-exported for the menus). */
export const scaleKeySide = (k: string): Side | null => (isScaleKey(k) ? keySide(k) : null);
