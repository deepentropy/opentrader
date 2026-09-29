/*
 * PriceScaleWatch — reports price-scale changes to the drawings overlay.
 *
 * lightweight-charts has no price-scale event, but it calls a series
 * primitive's updateAllViews() on every paint. The watch compares the visible
 * price range and its pixel mapping (covers autoscale on new prices, a
 * price-axis drag, log / percent mode and pane height changes) with the last
 * paint and, when they differ, runs `onChange` once in a microtask (outside
 * the chart's paint, so the overlay update cannot re-enter it). No polling;
 * no views of its own.
 */
import type { ISeriesApi, ISeriesPrimitive, SeriesAttachedParameter, SeriesType, Time } from "lightweight-charts";

export class PriceScaleWatch implements ISeriesPrimitive<Time> {
  private series: ISeriesApi<SeriesType, Time> | null = null;
  private key = "";
  private pending = false;

  constructor(private readonly onChange: () => void) {}

  attached(param: SeriesAttachedParameter<Time>): void {
    this.series = param.series;
    this.key = "";
  }

  detached(): void {
    this.series = null;
  }

  updateAllViews(): void {
    const s = this.series;
    if (!s) return;
    const r = s.priceScale().getVisibleRange();
    if (!r) return;
    const key = `${r.from}|${r.to}|${s.priceToCoordinate(r.from)}|${s.priceToCoordinate(r.to)}`;
    if (key === this.key) return;
    this.key = key;
    if (this.pending) return;
    this.pending = true;
    queueMicrotask(() => {
      this.pending = false;
      this.onChange();
    });
  }
}
