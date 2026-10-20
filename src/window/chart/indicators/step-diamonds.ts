/*
 * Diamonds of a "Step line with diamonds" plot: one diamond on each value
 * change of the step line. The step line itself is drawn by the indicator
 * renderer; this primitive attaches to that plot series.
 *
 * Reference shape: a rounded square turned 45°, side 8 / corner radius 2,
 * under a halo of side 21 / radius 5 in the plot colour at 15 % opacity, both
 * scaled by the square root of the line width in device pixels.
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

const DIAMOND = { side: 8, radius: 2 };
const HALO = { side: 21, radius: 5 };
const HALO_ALPHA = 0.15;

/** A rounded diamond centred on the origin (`scale` = the line-width factor). */
function diamondPath(size: { side: number; radius: number }, scale: number): Path2D {
  const p = new Path2D();
  const s = size.radius * scale;
  const r = (size.side * scale - 2 * s) * Math.SQRT1_2;
  const q = Math.PI / 4;
  p.arc(0, -r, s, -3 * q, -q);
  p.arc(r, 0, s, -q, q);
  p.arc(0, r, s, q, 3 * q);
  p.arc(-r, 0, s, 3 * q, 5 * q);
  p.closePath();
  return p;
}

export class StepDiamondsPrimitive implements ISeriesPrimitive<Time> {
  private chart: IChartApi | null = null;
  private series: ISeriesApi<SeriesType, Time> | null = null;
  private readonly views: IPrimitivePaneView[];
  private shapes: { width: number; diamond: Path2D; halo: Path2D; half: number } | null = null;

  constructor(
    private readonly points: { time: number; value: number }[],
    private readonly color: string,
    private readonly lineWidth = 1,
  ) {
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

  private shapesFor(width: number) {
    if (!this.shapes || this.shapes.width !== width) {
      const scale = Math.sqrt(width);
      this.shapes = { width, diamond: diamondPath(DIAMOND, scale), halo: diamondPath(HALO, scale), half: (HALO.side * scale * Math.SQRT2) / 2 };
    }
    return this.shapes;
  }

  private draw(target: CanvasRenderingTarget2D): void {
    const chart = this.chart;
    const series = this.series;
    if (!chart || !series) return;
    const timeScale = chart.timeScale();
    target.useBitmapCoordinateSpace(({ context: ctx, horizontalPixelRatio: hpr, verticalPixelRatio: vpr, bitmapSize }) => {
      const width = Math.max(1, Math.floor(this.lineWidth * hpr));
      const { diamond, halo, half } = this.shapesFor(width);
      const at: { x: number; y: number }[] = [];
      for (let i = 0; i < this.points.length; i++) {
        const p = this.points[i];
        if (i > 0 && p.value === this.points[i - 1].value) continue;
        const x = timeScale.timeToCoordinate(p.time as unknown as Time);
        const y = series.priceToCoordinate(p.value);
        if (x == null || y == null) continue;
        const bx = Math.round(x * hpr);
        const by = Math.round(y * vpr);
        if (by + half < 0 || by - half > bitmapSize.height) continue;
        at.push({ x: bx, y: by });
      }
      if (at.length === 0) return;
      const fill = (shape: Path2D) => {
        const path = new Path2D();
        for (const p of at) path.addPath(shape, { a: 1, b: 0, c: 0, d: 1, e: p.x, f: p.y });
        ctx.fill(path);
      };
      ctx.save();
      ctx.fillStyle = this.color;
      fill(diamond);
      ctx.globalAlpha = HALO_ALPHA;
      fill(halo);
      ctx.restore();
    });
  }
}
