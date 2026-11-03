/*
 * Column plots on a Volume Candles chart (the Volume study's bars): as wide as the candle above them. The reference
 * widens every bar of its time scale with the bar's volume, so a column under a heavy candle is as wide as the candle
 * (volume-widths.ts). The plot series stays for the scale, the legend and the crosshair, drawn transparent; this
 * primitive, attached to it, draws the columns with their colours.
 */
import type {
  IChartApi,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  Logical,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from 'lightweight-charts';
import type { CanvasRenderingTarget2D } from 'fancy-canvas';
import { volumeHalfWidth, volumeWidthFactor } from '../volume-widths';

export type ColumnPoint = { time: number; value: number; color: string };
type VolumeBar = { time: number; volume?: number };

export class VolumeColumnsPrimitive implements ISeriesPrimitive<Time> {
  private chart: IChartApi | null = null;
  private series: ISeriesApi<SeriesType, Time> | null = null;
  private readonly views: IPrimitivePaneView[];

  private readonly volumes = new Map<number, number>();

  /** `points` and `bars` (the chart's bars, whose volumes weigh the candles) sorted by time. */
  constructor(
    private readonly points: ColumnPoint[],
    private readonly base: number,
    private readonly bars: readonly VolumeBar[],
  ) {
    for (const b of bars) this.volumes.set(b.time, b.volume ?? 0);
    const renderer: IPrimitivePaneRenderer = { draw: (target) => this.draw(target) };
    this.views = [{ zOrder: () => 'normal', renderer: () => renderer }];
  }

  attached(param: SeriesAttachedParameter<Time, SeriesType>): void {
    this.chart = param.chart as IChartApi;
    this.series = param.series as ISeriesApi<SeriesType, Time>;
  }

  detached(): void {
    this.chart = null;
    this.series = null;
  }

  updateAllViews(): void {}

  paneViews(): readonly IPrimitivePaneView[] {
    return this.views;
  }

  private draw(target: CanvasRenderingTarget2D): void {
    const chart = this.chart;
    const series = this.series;
    const range = chart?.timeScale().getVisibleRange();
    if (!chart || !series || !range || !this.points.length) return;
    const timeScale = chart.timeScale();
    const x0 = timeScale.logicalToCoordinate(0 as Logical);
    const x1 = timeScale.logicalToCoordinate(1 as Logical);
    if (x0 == null || x1 == null) return;
    const barSpacing = x1 - x0;
    const yBase = series.priceToCoordinate(this.base);
    if (yBase == null) return;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const from = range.from as number;
      const to = range.to as number;
      // the bars on screen weigh the widths, as they do for the candles (one more each side of the visible range)
      const onScreen: number[] = [];
      for (let i = Math.max(0, lowerBound(this.bars, from) - 1); i < this.bars.length && (i === 0 || this.bars[i - 1].time <= to); i++) {
        const x = timeScale.timeToCoordinate(this.bars[i].time as unknown as Time);
        if (x != null && x >= 0 && x <= mediaSize.width) onScreen.push(this.bars[i].volume ?? 0);
      }
      const factor = volumeWidthFactor(onScreen);
      for (let i = Math.max(0, lowerBound(this.points, from) - 1); i < this.points.length && (i === 0 || this.points[i - 1].time <= to); i++) {
        const p = this.points[i];
        const x = timeScale.timeToCoordinate(p.time as unknown as Time);
        const y = series.priceToCoordinate(p.value);
        if (x == null || y == null) continue;
        const half = volumeHalfWidth(barSpacing, factor(this.volumes.get(p.time) ?? 0));
        ctx.fillStyle = p.color;
        ctx.fillRect(x - half, Math.min(y, yBase), half * 2, Math.max(1, Math.abs(yBase - y)));
      }
    });
  }
}

/** Index of the first item at or after `time`. */
function lowerBound(points: readonly { time: number }[], time: number): number {
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (points[m].time < time) lo = m + 1;
    else hi = m;
  }
  return lo;
}
