/*
 * Symbol description texts of a chart view: the status-line name, the price
 * axis currency label and the watermark.
 */
/*
 * ChartView — single chart pane backed by lightweight-charts (v5).
 *
 * Chart and series are imperative state held in plain `let` bindings.
 * Theme + chart-type changes both flow in via Solid effects that swap the
 * active series via createSeriesForType / setDataForType.
 *
 * Drawings: every kind lives in the <DrawingsOverlay> SVG layer fed a
 * Coords bridge (refreshed on every series rebuild) and a `coordEpoch`
 * counter that bumps on pan/zoom. Horizontal-line was the last holdout
 * (native priceLine through Feature 5a); Feature 5c moved it to the
 * overlay for parity with the other 13 kinds.
 */
import { createEffect, createSignal, onCleanup } from "solid-js";
import { createTextWatermark, type ITextWatermarkPluginApi, type Time } from "lightweight-charts";
import { getTickerInfo } from "../../../data/datafeed";
import { type ChartCx } from "./context";
import type { Accessor } from "solid-js";

/** What createTickerInfo adds to the chart context. */
export interface TickerInfoApi {
  legendDesc: Accessor<string>;
}

export function createTickerInfo(cx: ChartCx): TickerInfoApi {
  const { appearance, currentTokens, fullSymbol, intervalText, props, ticker } = cx;
  const [legendDesc, setLegendDesc] = createSignal("");

  createEffect(() => {
    const mode = appearance().legendTitleMode;
    const sym = fullSymbol();
    setLegendDesc("");
    if (!sym || (mode !== "Name" && mode !== "Symbol and name")) return;
    let alive = true;
    getTickerInfo(sym)
      .then((info) => { if (alive) setLegendDesc(info?.name ?? ""); })
      .catch(() => {});
    onCleanup(() => { alive = false; });
  });

  // Price-axis currency label: the symbol's currency (ticker info).
  createEffect(() => {
    const sym = fullSymbol();
    cx.setCurrency("");
    if (!sym) return;
    let alive = true;
    getTickerInfo(sym)
      .then((info) => { if (alive) cx.setCurrency((info?.currency ?? "").toUpperCase()); })
      .catch(() => {});
    onCleanup(() => { alive = false; });
  });

  let watermark: ITextWatermarkPluginApi<Time> | null = null;
  const [wmDesc, setWmDesc] = createSignal("");
  createEffect(() => {
    const a = appearance();
    const sym = fullSymbol();
    setWmDesc("");
    if (!a.watermarkDescription || !sym) return;
    let alive = true;
    getTickerInfo(sym)
      .then((info) => { if (alive) setWmDesc(info?.name ?? ""); })
      .catch(() => {});
    onCleanup(() => { alive = false; });
  });
  createEffect(() => {
    appearance();
    void props.theme;
    const sym = ticker();
    const ivl = intervalText();
    const desc = wmDesc();
    // In the price pane (it can move).
    cx.mainPaneEpoch();
    if (!cx.chart) return;
    const t = currentTokens();
    const head = [
      t.watermarkTicker ? sym : "",
      t.watermarkInterval ? ivl : "",
    ].filter(Boolean).join(", ");
    const lines: { text: string; color: string; fontSize: number }[] = [];
    if (head) lines.push({ text: head, color: t.watermarkColor, fontSize: 54 });
    if (t.watermarkDescription && desc) lines.push({ text: desc, color: t.watermarkColor, fontSize: 24 });
    // Recreate rather than applyOptions: dropping to zero lines must remove
    // the primitive, and recreation keeps one code path for both.
    try { watermark?.detach(); } catch { /* its pane is gone */ }
    watermark = null;
    if (lines.length > 0) watermark = createTextWatermark(cx.chart.panes()[cx.mainPane()], { lines });
  });

  return {
    legendDesc,
  };
}
