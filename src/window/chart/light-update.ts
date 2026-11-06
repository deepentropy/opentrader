import type { IChartApi, IPanePrimitive, Time } from "lightweight-charts";

/** Never attached: detaching it from a pane is how the chart library is asked for a light update. */
const NEVER_ATTACHED: IPanePrimitive<Time> = {};

/**
 * Draw the chart's panes again without laying them out. A primitive's requestUpdate is a full update (the panes laid
 * out again, then a second paint), and a series' applyOptions recolours every bar of that series on the next paint.
 */
export function lightUpdate(chart: IChartApi): void {
  chart.panes()[0]?.detachPrimitive(NEVER_ATTACHED);
}
