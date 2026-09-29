/*
 * Probe into the focused pane's live chart, for dialogs that show live
 * values (Settings → "Lock price to bar ratio"). The active ChartView sets it
 * while it is the active pane and clears it on blur / unmount.
 */
export type ActiveChartProbe = {
  /** Main series scale ratio: price units per bar (price range ÷ visible bars
   *  scaled by the pane's pixel aspect), undefined before the chart has data. */
  scaleRatio: () => number | undefined;
};

let probe: ActiveChartProbe | null = null;
let owner: object | null = null;

export function setActiveChartProbe(who: object, p: ActiveChartProbe): void {
  owner = who;
  probe = p;
}
export function clearActiveChartProbe(who: object): void {
  if (owner === who) { owner = null; probe = null; }
}
export const activeChartProbe = (): ActiveChartProbe | null => probe;
