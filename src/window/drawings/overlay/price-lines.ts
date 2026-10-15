/*
 * Price scale pills of the drawings overlay: one hidden-body price line per
 * point of a drawing with `showPriceLabels` (and the anchored VWAP's last
 * value), kept in sync with the drawings of the main pane.
 */
import { createEffect, onCleanup } from "solid-js";
import type { IPriceLine } from "lightweight-charts";
import type { Coords } from "../coords";
import { parseColor } from "lightweight-charts-drawing/core/color";
import { vwapLastValue } from "lightweight-charts-drawing/core/kinds/data-series";
import { type OverlayCx } from "./context";

/** What createPriceLines adds to the overlay context (nothing: it only
 *  syncs the chart's price lines). */
export type PriceLinesApi = Record<never, never>;

export function createPriceLines(cx: OverlayCx): PriceLinesApi {
  const { notShown, props } = cx;
  // ── Right-axis price pills (showPriceLabels) ───────────────────────────
  // For each endpoint of every drawing with `showPriceLabels` we create a
  // lightweight-charts price line with the body hidden — only the axis pill
  // shows. Diffed against a keyed Map so the sync is O(changes). The lines live
  // on ChartView's series; when the series is rebuilt (symbol/type change) the
  // `coords` identity changes and the old handles are stale, so we drop the map
  // without touching them (LWC disposed them with the old series).
  let priceLines = new Map<string, IPriceLine>();
  let priceLineCoords: Coords | null = null;
  createEffect(() => {
    const coords = props.coords;
    // Axis pills of the main pane's drawings (a study pane's series is
    // replaced on every study redraw).
    const list = props.drawings.filter((d) => !d.owner);
    if (coords !== priceLineCoords) {
      priceLines = new Map();
      priceLineCoords = coords;
    }
    if (!coords) return;
    const desired = new Map<string, { price: number; color: string }>();
    for (const d of list) {
      // Anchored VWAP "Price label": the VWAP's last value on the price
      // scale (re-read when the bars change; vwapData is cached per bars).
      if (d.kind === "anchored-vwap") {
        void props.coordEpoch;
        if (d.style.vwapPriceLabel === false || notShown(d)) continue;
        const v = vwapLastValue(d, coords);
        if (v != null) desired.set(`${d.id}#vwap`, { price: v, color: parseColor(d.style.color).hex });
        continue;
      }
      if (!d.style.showPriceLabels || notShown(d) || d.kind === "vertical-line") continue;
      d.points.forEach((pt, i) => desired.set(`${d.id}#${i}`, { price: pt.price, color: d.style.color }));
    }
    for (const [key, line] of priceLines) {
      const want = desired.get(key);
      if (!want) {
        coords.removePriceLine(line);
        priceLines.delete(key);
        continue;
      }
      line.applyOptions({ price: want.price, color: want.color, axisLabelColor: want.color });
    }
    for (const [key, want] of desired) {
      if (priceLines.has(key)) continue;
      priceLines.set(key, coords.addPriceLine({
        price: want.price,
        color: want.color,
        lineWidth: 1,
        lineVisible: false,
        axisLabelVisible: true,
        axisLabelColor: want.color,
        axisLabelTextColor: "#ffffff",
        title: "",
      }));
    }
  });
  onCleanup(() => {
    if (priceLineCoords) {
      for (const line of priceLines.values()) {
        try { priceLineCoords.removePriceLine(line); } catch { /* series already disposed */ }
      }
    }
    priceLines.clear();
  });

  return {};
}
