/*
 * What the chart legend drops when the chart is narrow (reference widths).
 * `width` is the room the legend has: the plot width less the legend's margins
 * (view/legend.tsx).
 */

/** Buttons a study row shows: all, without Settings / Source code (medium),
 *  the eye and More only (small). */
export function legendButtonsMode(width: number | undefined): "large" | "medium" | "small" {
  if (width === undefined) return "large";
  return width < 205 ? "small" : width < 222 ? "medium" : "large";
}

/** Title pieces of the series row and the compared symbols' rows. The
 *  exchange goes below 442 px; so does the interval of a single chart, while a
 *  chart of a multi-chart layout keeps its interval down to 192 px. At 132 px
 *  and less the series title is the ticker, whatever the Title setting. */
export function legendTitleParts(width: number | undefined, multiChart: boolean): { exchange: boolean; interval: boolean; tickerOnly: boolean } {
  if (width === undefined) return { exchange: true, interval: true, tickerOnly: false };
  return {
    exchange: width >= 442,
    interval: multiChart ? width >= 192 : width >= 442,
    tickerOnly: width <= 132,
  };
}

/** The series' open, high and low values are left out at 272 px and less
 *  (close and the changes stay). */
export function legendHidesMinorValues(width: number | undefined): boolean {
  return width !== undefined && width <= 272;
}
