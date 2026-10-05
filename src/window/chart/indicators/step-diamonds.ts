/*
 * Diamonds of a "Step line with diamonds" plot: one diamond on each value
 * change of the step line. The step line itself is drawn by the indicator
 * renderer; this primitive attaches to that plot series.
 */
import type {
  IChartApi,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from 'lightweight-charts';
import type { CanvasRenderingTarget2D } from 'fancy-canvas';

const SIZE = 6;

export class StepDiamondsPrimitive implements ISeriesPrimitive<Time> {
  private chart: IChartApi | null = null;
  private series: ISeriesApi<SeriesType, Time> | null = null;
  private readonly views: IPrimitivePaneView[];

  constructor(private readonly points: { time: number; value: number }[], private readonly color: string) {
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
    if (!chart || !series) return;
    const timeScale = chart.timeScale();
    target.useMediaCoordinateSpace(({ context: ctx }) => {
      ctx.fillStyle = this.color;
      for (let i = 0; i < this.points.length; i++) {
        const p = this.points[i];
        if (i > 0 && p.value === this.points[i - 1].value) continue;
        const x = timeScale.timeToCoordinate(p.time as unknown as Time);
        const y = series.priceToCoordinate(p.value);
        if (x == null || y == null) continue;
        ctx.beginPath();
        ctx.moveTo(x, y - SIZE);
        ctx.lineTo(x + SIZE, y);
        ctx.lineTo(x, y + SIZE);
        ctx.lineTo(x - SIZE, y);
        ctx.closePath();
        ctx.fill();
      }
    });
  }
}
