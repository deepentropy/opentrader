/*
 * Volume — TV's basic Volume study, absent from lightweight-charts-indicators.
 * Values captured off the live desktop app 25/07/2026 (study properties over
 * CDP): palette up #26A69A / down #EF5350 at 50% transparency, coloured by
 * close vs open (col_prev_close off), optional SMA(20) line #2962FF hidden by
 * default. TV draws it INSIDE the price pane on its own hidden scale pinned
 * to the bottom quarter — `ownScaleId` metadata, honoured by IndicatorLayer.
 */
import type { IndicatorRegistryEntry } from "lightweight-charts-indicators";

/** Extra metadata IndicatorLayer reads to give an overlay study a dedicated
 *  hidden price scale instead of the symbol scale. */
export type OwnScaleMeta = {
  ownScaleId?: string;
  ownScaleMargins?: { top: number; bottom: number };
};

const UP = "#26a69a80"; // palette colours at TV's transparency 50
const DOWN = "#ef535080";

export const VOLUME_ENTRY: IndicatorRegistryEntry = {
  id: "volume",
  group: "standard",
  name: "Volume",
  shortName: "Vol",
  category: "Volume",
  overlay: true, // price pane — but on its own scale (metadata below)
  metadata: {
    title: "Volume",
    shortTitle: "Vol",
    overlay: true,
    ownScaleId: "volume",
    ownScaleMargins: { top: 0.75, bottom: 0 },
  } as IndicatorRegistryEntry["metadata"] & OwnScaleMeta,
  inputConfig: [
    { id: "maLength", type: "int", title: "MA Length", defval: 20, min: 1 },
    { id: "showMA", type: "bool", title: "Volume MA", defval: false },
    { id: "colorOnPrevClose", type: "bool", title: "Color based on previous close", defval: false },
  ],
  plotConfig: [
    // Config colour solid (it feeds the legend value cell); the per-point
    // colours carry the 50% alpha.
    { id: "vol", title: "Volume", color: "#26a69a", style: "columns", lineWidth: 1 },
    { id: "vol_ma", title: "Volume MA", color: "#2962ff", lineWidth: 1 },
  ],
  defaultInputs: { maLength: 20, showMA: false, colorOnPrevClose: false },
  calculate(bars, inputs) {
    const maLength = Math.max(1, Number(inputs?.maLength ?? 20));
    const showMA = Boolean(inputs?.showMA ?? false);
    const onPrevClose = Boolean(inputs?.colorOnPrevClose ?? false);
    const vol: { time: number; value: number | null; color?: string }[] = [];
    const vol_ma: { time: number; value: number | null }[] = [];
    let sum = 0;
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      const v = b.volume ?? 0;
      const ref = onPrevClose && i > 0 ? bars[i - 1].close : b.open;
      vol.push({ time: b.time, value: v, color: b.close >= ref ? UP : DOWN });
      sum += v;
      if (i >= maLength) sum -= bars[i - maLength].volume ?? 0;
      vol_ma.push({ time: b.time, value: showMA && i >= maLength - 1 ? sum / maLength : null });
    }
    return {
      metadata: { title: "Volume", shorttitle: "Vol", overlay: true },
      plots: { vol, vol_ma },
    };
  },
};
