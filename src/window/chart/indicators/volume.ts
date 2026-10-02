/*
 * Volume — the basic Volume study, absent from lightweight-charts-indicators.
 * Palette up #26A69A / down #EF5350 at 50% transparency, coloured by close vs
 * open (col_prev_close off), optional SMA(20) line #2962FF hidden by default.
 * Drawn INSIDE the price pane on its own hidden scale pinned to the bottom
 * quarter — `ownScaleId` metadata, honoured by IndicatorLayer.
 */
import type { IndicatorRegistryEntry } from "lightweight-charts-indicators";

/** Extra metadata IndicatorLayer reads to give an overlay study a dedicated
 *  hidden price scale instead of the symbol scale. */
/** A plot hidden until checked in the Style tab (`defaultVisible: false`). */
export type PlotDefaultVisible = { defaultVisible?: boolean };

/** A plot coloured per point from a palette (points carry `paletteIndex`): the
 *  Style tab shows one colour row per entry. */
export type PlotPalette = {
  palette?: { name: string; color: string }[];
  /** Transparency (0-100) applied to the palette colours. */
  paletteTransparency?: number;
};

export type OwnScaleMeta = {
  ownScaleId?: string;
  ownScaleMargins?: { top: number; bottom: number };
};

/** Palette colour index of a bar: 0 = Growing, 1 = Falling (the reference
 *  volumePalette); the layer turns it into the Style tab colours. */
const GROWING = 0;
const FALLING = 1;

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
    // The reference inputs: MA Length and Color based on previous close. The MA
    // line is shown with the Style tab "Volume MA" check box (off by default).
    { id: "maLength", type: "int", title: "MA Length", defval: 20, min: 1, max: 2000 },
    { id: "colorOnPrevClose", type: "bool", title: "Color based on previous close", defval: false },
  ],
  plotConfig: [
    // Bars take the palette colour of their index at transparency 50
    // (Style tab "Growing" / "Falling" rows).
    {
      id: "vol", title: "Volume", color: "#26a69a", style: "columns", lineWidth: 1,
      palette: [{ name: "Growing", color: "#26a69a" }, { name: "Falling", color: "#ef5350" }],
      paletteTransparency: 50,
    } as IndicatorRegistryEntry["plotConfig"][number] & PlotPalette,
    { id: "vol_ma", title: "Volume MA", color: "#2962ff", lineWidth: 1, defaultVisible: false } as IndicatorRegistryEntry["plotConfig"][number] & PlotDefaultVisible,
  ],
  defaultInputs: { maLength: 20, colorOnPrevClose: false },
  calculate(bars, inputs) {
    const maLength = Math.max(1, Number(inputs?.maLength ?? 20));
    const onPrevClose = Boolean(inputs?.colorOnPrevClose ?? false);
    const vol: { time: number; value: number | null; paletteIndex: number }[] = [];
    const vol_ma: { time: number; value: number | null }[] = [];
    let sum = 0;
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      const v = b.volume ?? 0;
      const ref = onPrevClose && i > 0 ? bars[i - 1].close : b.open;
      vol.push({ time: b.time, value: v, paletteIndex: b.close >= ref ? GROWING : FALLING });
      sum += v;
      if (i >= maLength) sum -= bars[i - maLength].volume ?? 0;
      vol_ma.push({ time: b.time, value: i >= maLength - 1 ? sum / maLength : null });
    }
    return {
      metadata: { title: "Volume", shorttitle: "Vol", overlay: true },
      plots: { vol, vol_ma },
    };
  },
};
