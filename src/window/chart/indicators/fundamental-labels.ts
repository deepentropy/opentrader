/*
 * Value labels of a Fundamentals metric: under each step of its line, the
 * period's value, its change from the previous period and the period
 * ("$22.134M" / "(+6.81%)" / "Jun '20"), centred on the step's diamond in
 * the chart text colour. Attached to the metric's plot series.
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

export type FundamentalLabel = { time: number; value: number; lines: string[] };

/** Text size and line height (px), gap from the diamond centre to the first line. */
export const LABEL_FONT_PX = 11;
export const LABEL_LINE_PX = 14;
export const LABEL_TOP_PX = 8;

export class FundamentalLabelsPrimitive implements ISeriesPrimitive<Time> {
  private chart: IChartApi | null = null;
  private series: ISeriesApi<SeriesType, Time> | null = null;
  private readonly views: IPrimitivePaneView[];

  constructor(
    private readonly labels: FundamentalLabel[],
    private readonly color: string,
    private readonly fontFamily: string,
  ) {
    const renderer: IPrimitivePaneRenderer = { draw: (target) => this.draw(target) };
    this.views = [{ zOrder: () => 'top', renderer: () => renderer }];
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
    if (!chart || !series || this.labels.length === 0) return;
    const timeScale = chart.timeScale();
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      ctx.save();
      ctx.font = `${LABEL_FONT_PX}px ${this.fontFamily}`;
      ctx.fillStyle = this.color;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const l of this.labels) {
        const x = timeScale.timeToCoordinate(l.time as unknown as Time);
        const y = series.priceToCoordinate(l.value);
        if (x == null || y == null) continue;
        if (x < -100 || x > mediaSize.width + 100) continue;
        l.lines.forEach((text, k) => {
          ctx.fillText(text, x, y + LABEL_TOP_PX + LABEL_LINE_PX * (k + 0.5));
        });
      }
      ctx.restore();
    });
  }
}
