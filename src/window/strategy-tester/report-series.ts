/*
 * Custom bar series of the report tab charts, after the reference app's:
 * - BucketBarsSeries (DualRangeHistogramSeries 753235, bound to the price
 *   scale): several values per slot painted from the zero line in order at
 *   the same x (Weekly PnL: realized profit over favorable excursion,
 *   realized loss over adverse excursion; Results by time: winners over all
 *   trades). Columns follow the histogram layout, or a [padding, bar,
 *   padding] share of the slot (`layout`).
 * - PairBarsSeries (benchmarking 951347): the values side by side, each a
 *   1 / (n + 2) share of the slot, 2 px apart.
 * - CountBarsSeries (CustomHistogramSeries 686979): one value per slot, bar
 *   color per point, a share of the slot (`widthPercent`) or the slot less a
 *   padding on each side (`barPadding`); a value of 0 is an empty slot.
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
import { fillRoundRect, positionsBox, type DrawTarget } from "./report-chart-kit";

type Renderer<D extends CustomData<Time>, O> = {
  data: PaneRendererCustomData<Time, D> | null;
  options: O | null;
};

// ---------------------------------------------------------------------------
// Bucket bars.

export interface BucketBarsData extends CustomData<Time> {
  values: number[];
}

export interface BucketBarsOptions extends CustomSeriesOptions {
  colors: string[];
  /** Corner radius per value index. */
  borderRadius: number[];
  /** Widest column, px (0: none). */
  maxColumnWidth: number;
  /** Space kept on each side of a column, px (0: none). */
  columnPadding: number;
  /** [left padding, bar, right padding] shares of the slot; the histogram layout without. */
  layout?: readonly [number, number, number];
}

const BUCKET_DEFAULTS: BucketBarsOptions = {
  ...customSeriesDefaultOptions,
  colors: ["#ACE5DC", "#42BDA8", "#FCCACD", "#F77C80"],
  borderRadius: [2, 0, 2, 0],
  maxColumnWidth: 0,
  columnPadding: 0,
};

/** Column of the lightweight-charts histogram at x (bitmap px), the slot's gap left out. */
function histogramColumn(x: number, barSpacing: number, pr: number): { left: number; width: number } {
  const gap = Math.ceil(barSpacing * pr) <= 1 ? 0 : Math.max(1, Math.floor(pr));
  const w = Math.round(barSpacing * pr) - gap;
  const shiftLeft = w % 2 === 0;
  const half = (w - (shiftLeft ? 0 : 1)) / 2;
  const c = Math.round(x * pr);
  const left = c - half;
  const right = c + half - (shiftLeft ? 1 : 0);
  return { left, width: Math.min(Math.max(pr, right - left), barSpacing * pr) };
}

class BucketBarsRenderer implements ICustomSeriesPaneRenderer {
  readonly r: Renderer<BucketBarsData, BucketBarsOptions> = { data: null, options: null };

  draw(target: unknown, ptc: PriceToCoordinateConverter): void {
    (target as DrawTarget).useBitmapCoordinateSpace((s) => {
      const { data: d, options: o } = this.r;
      if (!d || !o || !d.bars.length || !d.visibleRange) return;
      const hr = s.horizontalPixelRatio;
      const vr = s.verticalPixelRatio;
      const zeroY = ptc(0) ?? 0;
      const limit = Math.min(o.maxColumnWidth > 0 ? o.maxColumnWidth : Infinity, o.columnPadding > 0 ? d.barSpacing - 2 * o.columnPadding : Infinity);
      const limitBitmap = Number.isFinite(limit) ? Math.round(limit * hr) : Infinity;
      for (let i = d.visibleRange.from; i < d.visibleRange.to; i++) {
        const bar = d.bars[i];
        const values = bar.originalData.values;
        if (!values?.length) continue;
        let left: number;
        let width: number;
        if (o.layout) {
          const [a, b, c] = o.layout;
          const total = a + b + c;
          if (total <= 0 || b <= 0) continue;
          const start = bar.x - d.barSpacing / 2 + (d.barSpacing * a) / total;
          const share = (d.barSpacing * b) / total;
          const w = o.maxColumnWidth > 0 ? Math.min(share, o.maxColumnWidth) : share;
          const x0 = start + share / 2 - w / 2;
          left = Math.round(x0 * hr);
          width = Math.max(1, Math.round((x0 + w) * hr) - left);
        } else {
          ({ left, width } = histogramColumn(bar.x, d.barSpacing, hr));
          if (width > limitBitmap) {
            left += Math.round((width - limitBitmap) / 2);
            width = limitBitmap;
          }
        }
        values.forEach((v, k) => {
          const box = positionsBox(zeroY, ptc(v) ?? zeroY, vr);
          const r = Math.floor(Math.min(o.borderRadius[k % o.borderRadius.length] * vr, width / 2, box.length / 2));
          fillRoundRect(s.context, left, box.position, width, box.length, o.colors[k % o.colors.length], v >= 0 ? [r, r, 0, 0] : [0, 0, r, r]);
        });
      }
    });
  }
}

export class BucketBarsSeries implements ICustomSeriesPaneView<Time, BucketBarsData, BucketBarsOptions> {
  private readonly view = new BucketBarsRenderer();
  /** Autoscale: the excursions and the realized value ([total, 0, winners] for Results by time). */
  priceValueBuilder(d: BucketBarsData): CustomSeriesPricePlotValues {
    const v = d.values;
    return [v[0], v[2] ?? 0, v[1] > 0 ? v[1] : (v[3] ?? 0)];
  }
  isWhitespace(d: BucketBarsData | { time: Time }): d is { time: Time } {
    return !(d as BucketBarsData).values?.length;
  }
  renderer(): ICustomSeriesPaneRenderer {
    return this.view;
  }
  update(data: PaneRendererCustomData<Time, BucketBarsData>, options: BucketBarsOptions): void {
    this.view.r.data = data;
    this.view.r.options = options;
  }
  defaultOptions(): BucketBarsOptions {
    return BUCKET_DEFAULTS;
  }
}

// ---------------------------------------------------------------------------
// Pair bars.

export interface PairBarsOptions extends CustomSeriesOptions {
  colors: string[];
  borderRadius: number;
}

const PAIR_DEFAULTS: PairBarsOptions = { ...customSeriesDefaultOptions, colors: ["#2962FF", "#E1575A"], borderRadius: 2 };

class PairBarsRenderer implements ICustomSeriesPaneRenderer {
  readonly r: Renderer<BucketBarsData, PairBarsOptions> = { data: null, options: null };

  draw(target: unknown, ptc: PriceToCoordinateConverter): void {
    (target as DrawTarget).useBitmapCoordinateSpace((s) => {
      const { data: d, options: o } = this.r;
      if (!d || !o || !d.bars.length || !d.visibleRange) return;
      const zeroY = ptc(0) ?? 0;
      const radius = Math.floor(o.borderRadius * s.horizontalPixelRatio);
      for (let i = d.visibleRange.from; i < d.visibleRange.to; i++) {
        const bar = d.bars[i];
        const values = bar.originalData.values;
        if (!values?.length) continue;
        const w = d.barSpacing / (values.length + 2);
        const gap = w >= 2 ? 2 : 0;
        const x0 = w + bar.x + gap - d.barSpacing / 2;
        const x1 = 2 * w + bar.x - gap - d.barSpacing / 2;
        values.forEach((v, k) => {
          const y = ptc(v) ?? zeroY;
          const ys = positionsBox(y, zeroY, s.verticalPixelRatio);
          const xs = positionsBox(x0 + k * w, x1 + k * w, s.horizontalPixelRatio);
          fillRoundRect(s.context, xs.position, ys.position, xs.length, ys.length, o.colors[k], y > zeroY ? [0, 0, radius, radius] : [radius, radius, 0, 0]);
        });
      }
    });
  }
}

export class PairBarsSeries implements ICustomSeriesPaneView<Time, BucketBarsData, PairBarsOptions> {
  private readonly view = new PairBarsRenderer();
  priceValueBuilder(d: BucketBarsData): CustomSeriesPricePlotValues {
    return [Math.max(...d.values), Math.min(0, ...d.values)];
  }
  isWhitespace(d: BucketBarsData | { time: Time }): d is { time: Time } {
    return !(d as BucketBarsData).values?.length;
  }
  renderer(): ICustomSeriesPaneRenderer {
    return this.view;
  }
  update(data: PaneRendererCustomData<Time, BucketBarsData>, options: PairBarsOptions): void {
    this.view.r.data = data;
    this.view.r.options = options;
  }
  defaultOptions(): PairBarsOptions {
    return PAIR_DEFAULTS;
  }
}

// ---------------------------------------------------------------------------
// Count bars.

export interface CountBarsData extends CustomData<Time> {
  value: number;
  barColor?: string;
}

export interface CountBarsOptions extends CustomSeriesOptions {
  barColor: string;
  widthPercent: number;
  /** Space on each side of a bar, px (wins over widthPercent). */
  barPadding?: number;
  radius: number;
  /** The bars stop this many px above the zero line. */
  barPaddingFromZeroLine: number;
}

const COUNT_DEFAULTS: CountBarsOptions = { ...customSeriesDefaultOptions, barColor: "#ACE5DC", widthPercent: 80, radius: 0, barPaddingFromZeroLine: 0 };

class CountBarsRenderer implements ICustomSeriesPaneRenderer {
  readonly r: Renderer<CountBarsData, CountBarsOptions> = { data: null, options: null };

  draw(target: unknown, ptc: PriceToCoordinateConverter): void {
    (target as DrawTarget).useBitmapCoordinateSpace((s) => {
      const { data: d, options: o } = this.r;
      if (!d || !o || !d.bars.length || !d.visibleRange) return;
      const hr = s.horizontalPixelRatio;
      const vr = s.verticalPixelRatio;
      const zeroY = (ptc(0) ?? 0) - o.barPaddingFromZeroLine;
      const width = o.barPadding !== undefined ? Math.max(1, (d.barSpacing - 2 * o.barPadding) * hr) : Math.max(1, d.barSpacing * (o.widthPercent / 100) * hr);
      for (let i = d.visibleRange.from; i < d.visibleRange.to; i++) {
        const bar = d.bars[i];
        const v = bar.originalData.value;
        const y = ptc(v);
        if (v === undefined || y === null) continue;
        const box = positionsBox(zeroY, y, vr);
        const left = Math.round(bar.x * hr - width / 2);
        const r = o.radius * vr;
        const color = bar.originalData.barColor ?? o.barColor;
        if (r > 0) fillRoundRect(s.context, left, box.position, Math.round(width), box.length, color, v > 0 ? [r, r, 0, 0] : [0, 0, r, r]);
        else {
          s.context.fillStyle = color;
          s.context.fillRect(left, box.position, Math.round(width), box.length);
        }
      }
    });
  }
}

export class CountBarsSeries implements ICustomSeriesPaneView<Time, CountBarsData, CountBarsOptions> {
  private readonly view = new CountBarsRenderer();
  priceValueBuilder(d: CountBarsData): CustomSeriesPricePlotValues {
    return [0, d.value];
  }
  isWhitespace(d: CountBarsData | { time: Time }): d is { time: Time } {
    return !("value" in d) || (d as CountBarsData).value === 0;
  }
  renderer(): ICustomSeriesPaneRenderer {
    return this.view;
  }
  update(data: PaneRendererCustomData<Time, CountBarsData>, options: CountBarsOptions): void {
    this.view.r.data = data;
    this.view.r.options = options;
  }
  defaultOptions(): CountBarsOptions {
    return COUNT_DEFAULTS;
  }
}
