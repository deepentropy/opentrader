import type { IChartApi } from "lightweight-charts";

/** Width of the chart's left or right price axis, 0 while it is not built: the chart throws "Value is null" when the
 *  axis is switched on but its widget comes with the next layout (a scale moved to that side, panes rebuilt). */
export function priceAxisWidth(chart: IChartApi, side: "left" | "right"): number {
  try {
    return chart.priceScale(side).width();
  } catch {
    return 0;
  }
}
