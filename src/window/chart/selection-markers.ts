/*
 * Selection markers of a selected study (the reference app's
 * "source_selection_markers"): along each plot of the selected study, one
 * marker every floor(120 / bar spacing) bars, a disc of the chart background
 * (radius 5) with a 1 px ring (radius 3..4) in ot-blue-600.
 *
 * Marker bars (reference SelectionIndexes): the step and an anchor bar
 * (last visible bar % step) are fixed when the markers first draw and kept
 * while the study stays selected (zooming changes the spacing, not the step);
 * the anchor follows its bar time when history is prepended.
 */
import { MismatchDirection } from "lightweight-charts";
import type {
  IChartApi,
  ISeriesApi,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesPrimitive,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from "lightweight-charts";
import type { CanvasRenderingTarget2D } from "fancy-canvas";
import { hexToRgb, parseColor } from "lightweight-charts-drawing/core/color";

const RADIUS = 4;
const RING_COLOR = "#1e53e5"; // ot-blue-600
/** Spacing of the markers in px at selection time. */
const MARKER_SPACING = 120;

/** Value of the plot at a bar (logical index), or null for no value. */
export type PlotValueAt = (index: number) => number | null;
/** Chart background at a height (0 = pane top, 1 = bottom). */
export type BackgroundAt = (yFraction: number) => string;

/** Background of a solid or vertical-gradient chart at a height. */
export function chartBackgroundAt(top: string, bottom: string, gradient: boolean): BackgroundAt {
  if (!gradient || top === bottom) return () => top;
  const a = parseColor(top);
  const b = parseColor(bottom);
  const [r0, g0, b0] = hexToRgb(a.hex);
  const [r1, g1, b1] = hexToRgb(b.hex);
  return (t) => {
    const k = Math.max(0, Math.min(1, t));
    const mix = (x: number, y: number) => Math.round(x + (y - x) * k);
    const alpha = (a.opacity + (b.opacity - a.opacity) * k) / 100;
    return `rgba(${mix(r0, r1)}, ${mix(g0, g1)}, ${mix(b0, b1)}, ${alpha})`;
  };
}

export class SelectionMarkers implements ISeriesPrimitive<Time> {
  private chart: IChartApi | null = null;
  private series: ISeriesApi<SeriesType, Time> | null = null;
  private step: number | null = null;
  private anchorTime: Time | null = null;
  private readonly views: IPrimitivePaneView[];

  constructor(private valueAt: PlotValueAt, private bgAt: BackgroundAt) {
    this.views = [{ renderer: () => this.renderer, zOrder: () => "top" }];
  }

  private readonly renderer: IPrimitivePaneRenderer = {
    draw: (target: CanvasRenderingTarget2D) => {
      const chart = this.chart;
      if (!chart) return;
      const ts = chart.timeScale();
      const pts: { x: number; y: number }[] = [];
      for (const i of this.indexes()) {
        const v = this.valueAt(i);
        if (v == null || !Number.isFinite(v)) continue;
        const x = ts.logicalToCoordinate(i as never);
        const y = this.series?.priceToCoordinate(v) ?? null;
        if (x == null || y == null) continue;
        pts.push({ x, y });
      }
      if (!pts.length) return;
      target.useBitmapCoordinateSpace(({ context: ctx, horizontalPixelRatio: hpr, verticalPixelRatio: vpr, mediaSize }) => {
        const half = (Math.max(1, Math.floor(hpr)) % 2) / 2;
        for (const p of pts) {
          const cx = Math.round(p.x * hpr) + half;
          const cy = Math.round(p.y * vpr) + half;
          const disc = (r: number) => {
            const path = new Path2D();
            path.arc(cx, cy, r, 0, 2 * Math.PI, true);
            return path;
          };
          ctx.fillStyle = this.bgAt(mediaSize.height > 0 ? p.y / mediaSize.height : 0);
          ctx.fill(disc(Math.round(1.25 * RADIUS * hpr) + half));
          const ring = disc(Math.round(RADIUS * hpr));
          ring.addPath(disc(Math.floor((RADIUS - 1) * hpr)));
          ctx.fillStyle = RING_COLOR;
          ctx.fill(ring, "evenodd");
        }
      });
    },
  };

  /** Bars carrying a marker in the visible range. */
  private indexes(): number[] {
    const chart = this.chart;
    if (!chart) return [];
    const ts = chart.timeScale();
    const range = ts.getVisibleLogicalRange();
    if (!range) return [];
    const first = Math.ceil(range.from);
    const last = Math.floor(range.to);
    if (last < first) return [];
    if (this.step === null || this.anchorTime === null) {
      this.step = Math.max(1, Math.floor(MARKER_SPACING / ts.options().barSpacing));
      const anchor = ((last % this.step) + this.step) % this.step;
      // Anchor kept as a bar time (indexes shift when history is prepended).
      const item = this.series?.dataByIndex(anchor, MismatchDirection.NearestRight) ?? null;
      if (!item) { this.step = null; return []; }
      this.anchorTime = item.time;
    }
    const n = ts.timeToIndex(this.anchorTime, true);
    if (n === null) return [];
    const step = this.step;
    const out: number[] = [];
    for (let l = Math.floor((first - n) / step), e = Math.floor((last - n) / step); l <= e; l++) out.push(n + l * step);
    return out;
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
}
