/*
 * Drawing panes: each chart pane the drawings can live in. A drawing is
 * drawn, clipped and hit-tested in its owner's pane (Drawing.owner = the
 * study id; absent = the main series pane), in that pane's own pixel space
 * (y = 0 at the pane top) and price scale.
 */
import type { ISeriesApi, SeriesType, Time } from "lightweight-charts";
import type { Coords } from "lightweight-charts-drawing/core/coords";

export type DrawingPane = {
  /** Owner id of the drawings in this pane; null = the main series pane. */
  key: string | null;
  /** Pane top and height in overlay px. */
  top: number;
  height: number;
  /** Pane-local coords (y relative to the pane top). */
  coords: Coords;
};

/** lightweight-charts PriceScaleMode.Logarithmic. */
const PRICE_SCALE_MODE_LOG = 1;

/**
 * Coords of a study pane: time from the main coords, price from the study's
 * series (read at each call: a study redraw replaces its series). The magnet
 * candidates are the pane's study values.
 */
export function studyPaneCoords(
  main: Coords,
  series: () => ISeriesApi<SeriesType> | null,
  valuesAt: (sec: number | undefined) => number[],
): Coords {
  return {
    ...main,
    priceToY: (p) => series()?.priceToCoordinate(p) ?? null,
    yToPrice: (y) => series()?.coordinateToPrice(y) ?? null,
    isLog: () => series()?.priceScale().options().mode === PRICE_SCALE_MODE_LOG,
    indicatorValuesAt: (t: Time) => valuesAt(typeof t === "number" ? t : undefined),
    pipSize: () => {
      const pf = series()?.options().priceFormat;
      return pf && typeof pf.minMove === "number" && pf.minMove > 0 ? pf.minMove : 0.01;
    },
    addPriceLine: (opts) => {
      const s = series();
      if (!s) throw new Error("study pane has no series");
      return s.createPriceLine(opts);
    },
    removePriceLine: (line) => {
      try { series()?.removePriceLine(line); } catch { /* series replaced */ }
    },
  };
}

/** Coords shifted down by `top` px: pane-local coords seen in the coordinate
 *  space of the whole overlay (a vertical line extended through every pane). */
export function offsetCoords(c: Coords, top: number): Coords {
  if (top === 0) return c;
  return {
    ...c,
    priceToY: (p) => {
      const y = c.priceToY(p);
      return y == null ? null : y + top;
    },
    yToPrice: (y) => c.yToPrice(y - top),
  };
}
