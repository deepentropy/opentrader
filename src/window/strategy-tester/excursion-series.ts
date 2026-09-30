/*
 * "Trades excursions" bars of the Performance chart: the reference app's
 * DualRangeHistogramSeries (module 583850; design doc §14.10), for the case
 * the reference app uses (values not bound to the price scale).
 *
 * Each point holds [run-up, profit > 0, -drawdown, loss < 0]; the 4 bars are
 * painted in that order at the same x (profit over run-up, loss over
 * drawdown), from the price scale's zero line. Height = |v| / largest |v| of
 * the visible points x 65 px (maxHeight 130 / 2). Columns follow the
 * lightweight-charts histogram layout; radius [2, 0, 2, 0] per value index
 * (top corners for positive bars, bottom corners for negative ones).
 */
import {
  customSeriesDefaultOptions,
  type CustomData,
  type CustomSeriesOptions,
  type CustomSeriesPricePlotValues,
  type ICustomSeriesPaneRenderer,
  type ICustomSeriesPaneView,
  type PaneRendererCustomData,
  type PriceToCoordinateConverter,
  type Time,
} from "lightweight-charts";

export interface ExcursionData extends CustomData<Time> {
  values: [number, number, number, number];
}

/** Dark theme colors: run-up, profit, drawdown, loss. */
export const EXCURSION_COLORS = ["#10443B", "#056656", "#4D191D", "#991F29"] as const;
const RADIUS = [2, 0, 2, 0];
const MAX_HEIGHT = 130;

type Column = { left: number; right: number; shiftLeft: boolean };
type Bitmap = {
  context: CanvasRenderingContext2D;
  horizontalPixelRatio: number;
  verticalPixelRatio: number;
};
type Target = { useBitmapCoordinateSpace: (f: (s: Bitmap) => void) => void };

const gapOf = (barSpacing: number, pr: number) => (Math.ceil(barSpacing * pr) <= 1 ? 0 : Math.max(1, Math.floor(pr)));

function columnLayout(barSpacing: number, pr: number) {
  const spacing = gapOf(barSpacing, pr);
  const width = Math.round(barSpacing * pr) - spacing;
  const shiftLeft = width % 2 === 0;
  return { spacing, shiftLeft, half: (width - (shiftLeft ? 0 : 1)) / 2, pr };
}

function place(x: number, l: ReturnType<typeof columnLayout>, prev: Column | undefined): Column {
  const xb = x * l.pr;
  const c = Math.round(xb);
  const col = { left: c - l.half, right: c + l.half - (l.shiftLeft ? 1 : 0), shiftLeft: c > xb };
  const n = l.spacing + 1;
  if (prev && col.left - prev.right !== n) {
    if (prev.shiftLeft) prev.right = col.left - n;
    else col.left = prev.right + n;
  }
  return col;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number[], fill: string, border: number) {
  ctx.save();
  const u = border / 2;
  ctx.beginPath();
  ctx.roundRect(x + u, y + u, w - border, h - border, r.map((v) => (v === 0 ? 0 : v - u)));
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.restore();
}

class ExcursionRenderer implements ICustomSeriesPaneRenderer {
  private data: PaneRendererCustomData<Time, ExcursionData> | null = null;

  update(data: PaneRendererCustomData<Time, ExcursionData>): void {
    this.data = data;
  }

  draw(target: Target, priceToCoordinate: PriceToCoordinateConverter): void {
    target.useBitmapCoordinateSpace((s) => this.drawImpl(s, priceToCoordinate));
  }

  private drawImpl(s: Bitmap, ptc: PriceToCoordinateConverter): void {
    const d = this.data;
    if (!d || !d.bars.length || !d.visibleRange) return;
    const { from, to } = d.visibleRange;
    let maxAbs = 0;
    for (let i = from; i < to; i++) for (const v of d.bars[i].originalData.values) maxAbs = Math.max(maxAbs, Math.abs(v));
    if (maxAbs === 0) return;
    const half = MAX_HEIGHT / 2;
    const pr = s.horizontalPixelRatio;
    const layout = columnLayout(d.barSpacing, pr);
    const cols: (Column | undefined)[] = [];
    let prev: Column | undefined;
    for (let i = from; i < Math.min(to, d.bars.length); i++) {
      cols[i] = place(d.bars[i].x, layout, prev);
      prev = cols[i];
    }
    let minWidth = Math.ceil(d.barSpacing * pr);
    for (let i = from; i < to; i++) {
      const c = cols[i];
      if (!c) continue;
      if (c.right < c.left) c.right = c.left;
      minWidth = Math.min(minWidth, c.right - c.left + 1);
    }
    if (layout.spacing > 0 && minWidth < 4) {
      for (let i = from; i < to; i++) {
        const c = cols[i];
        if (!c || c.right - c.left + 1 <= minWidth) continue;
        if (c.shiftLeft) c.right -= 1;
        else c.left += 1;
      }
    }
    const zeroY = ptc(0) ?? 0;
    const border = d.barSpacing * pr < 4 ? 0 : Math.max(1, 0.5 * pr);
    const vr = s.verticalPixelRatio;
    for (let i = from; i < to; i++) {
      const c = cols[i];
      if (!c) continue;
      const width = Math.min(Math.max(pr, c.right - c.left), d.barSpacing * pr);
      d.bars[i].originalData.values.forEach((v, k) => {
        const y = (Math.abs(v) / maxAbs) * Math.sign(v) * half;
        const a = Math.round(vr * zeroY);
        const b = Math.round(vr * (zeroY - y));
        const top = Math.min(a, b);
        const length = Math.abs(b - a) + 1;
        const r = Math.floor(Math.min(RADIUS[k] * vr, width / 2, length / 2));
        roundRect(s.context, c.left, top, width, length, v >= 0 ? [r, r, 0, 0] : [0, 0, r, r], EXCURSION_COLORS[k], border);
      });
    }
  }
}

export class ExcursionSeries implements ICustomSeriesPaneView<Time, ExcursionData, CustomSeriesOptions> {
  private readonly view = new ExcursionRenderer();
  priceValueBuilder(): CustomSeriesPricePlotValues {
    return [0];
  }
  isWhitespace(d: ExcursionData | { time: Time }): d is { time: Time } {
    return !(d as ExcursionData).values?.length;
  }
  renderer(): ICustomSeriesPaneRenderer {
    return this.view;
  }
  update(data: PaneRendererCustomData<Time, ExcursionData>): void {
    this.view.update(data);
  }
  defaultOptions(): CustomSeriesOptions {
    return customSeriesDefaultOptions;
  }
}
