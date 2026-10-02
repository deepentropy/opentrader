/*
 * Baseline chart type: the Top line and Bottom line with their own width and
 * style. The library's baseline series strokes both halves with one width /
 * style, so the series runs with `lineVisible: false` (fills, price label and
 * crosshair marker colours stay the library's) and this primitive strokes the
 * line twice, clipped above and below the base level.
 */
import { LineStyle, type IChartApi, type IPrimitivePaneRenderer, type IPrimitivePaneView, type ISeriesApi, type ISeriesPrimitive, type SeriesAttachedParameter, type SeriesType, type Time } from "lightweight-charts";
import type { CanvasRenderingTarget2D } from "fancy-canvas";

export type BaselineLineSpec = { color: string; width: number; style: LineStyle };

/** The library's dash pattern of a line style (draw-line.ts setLineStyle). */
function dashOf(style: LineStyle, w: number): number[] {
  switch (style) {
    case LineStyle.Dotted: return [w, w];
    case LineStyle.Dashed: return [2 * w, 2 * w];
    case LineStyle.LargeDashed: return [6 * w, 6 * w];
    case LineStyle.SparseDotted: return [w, 4 * w];
    default: return [];
  }
}

export class BaselineLines implements ISeriesPrimitive<Time> {
  private chart: IChartApi | null = null;
  private series: ISeriesApi<SeriesType, Time> | null = null;
  private readonly views: IPrimitivePaneView[];

  constructor(private top: BaselineLineSpec, private bottom: BaselineLineSpec) {
    const renderer: IPrimitivePaneRenderer = { draw: (t) => this.draw(t) };
    this.views = [{ zOrder: () => "normal", renderer: () => renderer }];
  }

  attached(p: SeriesAttachedParameter<Time, SeriesType>): void {
    this.chart = p.chart as IChartApi;
    this.series = p.series as ISeriesApi<SeriesType, Time>;
  }

  detached(): void {
    this.chart = null;
    this.series = null;
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this.views;
  }

  private draw(target: CanvasRenderingTarget2D): void {
    const chart = this.chart;
    const series = this.series;
    if (!chart || !series || !series.options().visible) return;
    const base = (series.options() as { baseValue?: { price?: number } }).baseValue?.price;
    const baseY = base == null ? null : series.priceToCoordinate(base);
    const ts = chart.timeScale();
    const range = ts.getVisibleLogicalRange();
    if (!range || baseY == null) return;
    // Visible bars plus one on each side, so the line runs to the pane edges.
    const pts: { x: number; y: number }[] = [];
    for (let i = Math.floor(range.from) - 1; i <= Math.ceil(range.to) + 1; i++) {
      const d = series.dataByIndex(i) as { value?: number } | null;
      if (d?.value == null) continue;
      const x = ts.logicalToCoordinate(i as never);
      const y = series.priceToCoordinate(d.value);
      if (x == null || y == null) continue;
      pts.push({ x, y });
    }
    if (pts.length < 2) return;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const stroke = (spec: BaselineLineSpec, clipTop: number, clipBottom: number) => {
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, clipTop, mediaSize.width, Math.max(0, clipBottom - clipTop));
        ctx.clip();
        ctx.strokeStyle = spec.color;
        ctx.lineWidth = spec.width;
        ctx.lineJoin = "round";
        ctx.setLineDash(dashOf(spec.style, spec.width));
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let k = 1; k < pts.length; k++) ctx.lineTo(pts[k].x, pts[k].y);
        ctx.stroke();
        ctx.restore();
      };
      stroke(this.top, 0, baseY);
      stroke(this.bottom, baseY, mediaSize.height);
    });
  }
}
