/*
 * The chart library applies `setVisibleLogicalRange` on its next frame: until then `getVisibleLogicalRange` still
 * answers the range before. Code that saves the view, changes something and puts the view back within that frame
 * (IndicatorController.keepView) would put back the old range and undo the move (a jump framed right after a symbol
 * switch, then undone by a script update, #307). The chart's time scale records the range it was asked for until it
 * is drawn.
 */
import type { IChartApi, LogicalRange } from "lightweight-charts";

const pending = new WeakMap<object, LogicalRange>();

/** Records each range `chart` is asked to show until the frame that draws it. */
export function trackPendingRange(chart: IChartApi): void {
  const ts = chart.timeScale();
  const set = ts.setVisibleLogicalRange.bind(ts);
  ts.setVisibleLogicalRange = (range) => {
    pending.set(ts, { from: range.from, to: range.to } as LogicalRange);
    requestAnimationFrame(() => {
      if (pending.get(ts)?.from === range.from && pending.get(ts)?.to === range.to) pending.delete(ts);
    });
    set(range);
  };
}

/** The range `chart` was asked to show and has not drawn yet, if any. */
export function pendingRange(chart: IChartApi): LogicalRange | undefined {
  return pending.get(chart.timeScale());
}
