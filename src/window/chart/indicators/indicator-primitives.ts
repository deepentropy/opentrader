/*
 * Canvas series-primitives for indicator plot styles that lightweight-charts
 * has no native series for.  Ported, near-verbatim, from the renderer the
 * indicator library ships in its own example harness
 *   github.com/deepentropy/lightweight-charts-indicators — example/src/chart.ts
 * so our on-chart drawing matches the library author's reference exactly.
 *
 * Each primitive attaches to a (usually invisible) anchor LineSeries via
 * `series.attachPrimitive()` and paints with the chart's media-space 2D
 * context.  See [[IndicatorLayer]] for how they're wired per indicator.
 */
import type {
  IChartApi,
  ISeriesApi,
  ISeriesPrimitive,
  IPrimitivePaneView,
  IPrimitivePaneRenderer,
  SeriesAttachedParameter,
  Time,
  SeriesType,
} from 'lightweight-charts';
import type { CanvasRenderingTarget2D } from 'fancy-canvas';
import type { MarkerData } from 'lightweight-charts-indicators';

/** Base class — holds the chart/series refs handed over on attach. */
class BasePrimitive implements ISeriesPrimitive<Time> {
  protected _chart: IChartApi | null = null;
  protected _series: ISeriesApi<SeriesType, Time> | null = null;
  protected _requestUpdate: (() => void) | null = null;

  attached(param: SeriesAttachedParameter<Time, SeriesType>): void {
    this._chart = param.chart as IChartApi;
    this._series = param.series as ISeriesApi<SeriesType, Time>;
    this._requestUpdate = param.requestUpdate;
  }

  detached(): void {
    this._chart = null;
    this._series = null;
    this._requestUpdate = null;
  }
}

/** Estimate bar width from the time scale's visible range. */
export function getBarWidth(timeScale: ReturnType<IChartApi['timeScale']>, mediaWidth: number): number {
  const visibleRange = timeScale.getVisibleLogicalRange();
  if (!visibleRange) return 8;
  const barsCount = visibleRange.to - visibleRange.from;
  if (barsCount <= 0) return 8;
  return Math.max(1, mediaWidth / barsCount);
}

// ─── Line-break primitive — draws a line that breaks at NaN gaps ────────────
export class LineBrPrimitive extends BasePrimitive {
  private _data: Array<{ time: number; value: number }> = [];
  private _color = '#2962FF';
  private _lineWidth = 2;
  private _lineStyle = 0; // LineStyle.Solid
  private _withSteps = false;
  private _views: IPrimitivePaneView[] = [new LineBrPaneView(this)];

  setData(data: Array<{ time: number; value: number }>, color: string, lineWidth = 2, lineStyle = 0, withSteps = false): void {
    this._data = data;
    this._color = color;
    this._lineWidth = lineWidth;
    this._lineStyle = lineStyle;
    this._withSteps = withSteps;
    this._requestUpdate?.();
  }

  getData() { return this._data; }
  getColor() { return this._color; }
  getLineWidth() { return this._lineWidth; }
  getLineStyle() { return this._lineStyle; }
  getWithSteps() { return this._withSteps; }
  getChart() { return this._chart; }
  getSeries() { return this._series; }

  updateAllViews(): void {}
  paneViews(): readonly IPrimitivePaneView[] { return this._views; }
}

class LineBrPaneView implements IPrimitivePaneView {
  constructor(private _source: LineBrPrimitive) {}
  zOrder(): 'normal' { return 'normal'; }
  renderer(): IPrimitivePaneRenderer | null { return new LineBrRenderer(this._source); }
}

class LineBrRenderer implements IPrimitivePaneRenderer {
  constructor(private _source: LineBrPrimitive) {}

  draw(target: CanvasRenderingTarget2D): void {
    const chart = this._source.getChart();
    const series = this._source.getSeries();
    if (!chart || !series) return;

    const data = this._source.getData();
    const color = this._source.getColor();
    const lineWidth = this._source.getLineWidth();
    const lineStyle = this._source.getLineStyle();
    const withSteps = this._source.getWithSteps();
    const timeScale = chart.timeScale();

    target.useMediaCoordinateSpace(({ context: ctx }) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = lineWidth;
      if (lineStyle === 1) ctx.setLineDash([4, 4]);
      else if (lineStyle === 2) ctx.setLineDash([2, 2]);

      let drawing = false;
      let prevY = 0;

      for (const point of data) {
        const isNaN = point.value == null || Number.isNaN(point.value);
        if (isNaN) {
          if (drawing) { ctx.stroke(); drawing = false; }
          continue;
        }
        const x = timeScale.timeToCoordinate(point.time as unknown as Time);
        const y = series.priceToCoordinate(point.value);
        if (x == null || y == null) {
          if (drawing) { ctx.stroke(); drawing = false; }
          continue;
        }
        if (!drawing) {
          ctx.beginPath();
          ctx.moveTo(x as number, y as number);
          drawing = true;
        } else {
          if (withSteps) ctx.lineTo(x as number, prevY);
          ctx.lineTo(x as number, y as number);
        }
        prevY = y as number;
      }
      if (drawing) ctx.stroke();
      ctx.setLineDash([]);
    });
  }
}

// ─── Cross marker plot style — draws X marks at data points ─────────────────
export class CrossPlotPrimitive extends BasePrimitive {
  private _data: Array<{ time: number; value: number }> = [];
  private _color = '#2962FF';
  private _size = 6;
  private _views: IPrimitivePaneView[] = [new CrossPlotPaneView(this)];

  setData(data: Array<{ time: number; value: number }>, color: string, size = 6): void {
    this._data = data;
    this._color = color;
    this._size = size;
    this._requestUpdate?.();
  }

  getData() { return this._data; }
  getColor() { return this._color; }
  getSize() { return this._size; }
  getChart() { return this._chart; }
  getSeries() { return this._series; }

  updateAllViews(): void {}
  paneViews(): readonly IPrimitivePaneView[] { return this._views; }
}

class CrossPlotPaneView implements IPrimitivePaneView {
  constructor(private _source: CrossPlotPrimitive) {}
  zOrder(): 'normal' { return 'normal'; }
  renderer(): IPrimitivePaneRenderer | null { return new CrossPlotRenderer(this._source); }
}

class CrossPlotRenderer implements IPrimitivePaneRenderer {
  constructor(private _source: CrossPlotPrimitive) {}

  draw(target: CanvasRenderingTarget2D): void {
    const chart = this._source.getChart();
    const series = this._source.getSeries();
    if (!chart || !series) return;

    const data = this._source.getData();
    const color = this._source.getColor();
    const halfSize = this._source.getSize();
    const timeScale = chart.timeScale();

    target.useMediaCoordinateSpace(({ context: ctx }) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      for (const point of data) {
        if (point.value == null || Number.isNaN(point.value)) continue;
        const x = timeScale.timeToCoordinate(point.time as unknown as Time);
        const y = series.priceToCoordinate(point.value);
        if (x == null || y == null) continue;
        ctx.beginPath();
        ctx.moveTo((x as number) - halfSize, (y as number) - halfSize);
        ctx.lineTo((x as number) + halfSize, (y as number) + halfSize);
        ctx.moveTo((x as number) + halfSize, (y as number) - halfSize);
        ctx.lineTo((x as number) - halfSize, (y as number) + halfSize);
        ctx.stroke();
      }
    });
  }
}

// ─── Plot fill — filled band between two price levels per bar ───────────────
export interface PlotFillBar { time: number; upper: number; lower: number }

export class PlotFillPrimitive extends BasePrimitive {
  private _data: PlotFillBar[] = [];
  private _color = '#2962FF40';
  private _views: IPrimitivePaneView[] = [new PlotFillPaneView(this)];

  setData(data: PlotFillBar[], color: string): void {
    this._data = data;
    this._color = color;
    this._requestUpdate?.();
  }

  getData() { return this._data; }
  getColor() { return this._color; }
  getChart() { return this._chart; }
  getSeries() { return this._series; }

  updateAllViews(): void {}
  paneViews(): readonly IPrimitivePaneView[] { return this._views; }
}

class PlotFillPaneView implements IPrimitivePaneView {
  constructor(private _source: PlotFillPrimitive) {}
  zOrder(): 'bottom' { return 'bottom'; }
  renderer(): IPrimitivePaneRenderer | null { return new PlotFillRenderer(this._source); }
}

class PlotFillRenderer implements IPrimitivePaneRenderer {
  constructor(private _source: PlotFillPrimitive) {}

  draw(target: CanvasRenderingTarget2D): void {
    const chart = this._source.getChart();
    const series = this._source.getSeries();
    if (!chart || !series) return;

    const data = this._source.getData();
    const color = this._source.getColor();
    const timeScale = chart.timeScale();

    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      ctx.fillStyle = color;
      const barWidth = getBarWidth(timeScale, mediaSize.width);
      for (const bar of data) {
        const x = timeScale.timeToCoordinate(bar.time as unknown as Time);
        if (x == null) continue;
        const yUpper = series.priceToCoordinate(bar.upper);
        const yLower = series.priceToCoordinate(bar.lower);
        if (yUpper == null || yLower == null) continue;
        const top = Math.min(yUpper as number, yLower as number);
        const bottom = Math.max(yUpper as number, yLower as number);
        ctx.fillRect((x as number) - barWidth / 2, top, barWidth, bottom - top);
      }
    });
  }
}

// ─── Background color — full-height column behind each colored bar (bgcolor) ─
export interface BarColorPoint { time: number; color: string }

export class BgColorPrimitive extends BasePrimitive {
  private _data: BarColorPoint[] = [];
  private _views: IPrimitivePaneView[] = [new BgColorPaneView(this)];

  setData(data: BarColorPoint[]): void {
    this._data = data;
    this._requestUpdate?.();
  }

  getData() { return this._data; }
  getChart() { return this._chart; }

  updateAllViews(): void {}
  paneViews(): readonly IPrimitivePaneView[] { return this._views; }
}

class BgColorPaneView implements IPrimitivePaneView {
  constructor(private _source: BgColorPrimitive) {}
  // Behind plots and candles — bgcolor is a background wash.
  zOrder(): 'bottom' { return 'bottom'; }
  renderer(): IPrimitivePaneRenderer | null { return new BgColorRenderer(this._source); }
}

class BgColorRenderer implements IPrimitivePaneRenderer {
  constructor(private _source: BgColorPrimitive) {}

  draw(target: CanvasRenderingTarget2D): void {
    const chart = this._source.getChart();
    if (!chart) return;
    const data = this._source.getData();
    const timeScale = chart.timeScale();

    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const barWidth = getBarWidth(timeScale, mediaSize.width);
      for (const bar of data) {
        const x = timeScale.timeToCoordinate(bar.time as unknown as Time);
        if (x == null) continue;
        ctx.fillStyle = bar.color;
        ctx.fillRect((x as number) - barWidth / 2, 0, barWidth, mediaSize.height);
      }
    });
  }
}

// ─── Bar color — repaints the OHLC candle of each colored bar (barcolor) ─────
export interface BarColorCandle { time: number; open: number; high: number; low: number; close: number; color: string }

export class BarColorPrimitive extends BasePrimitive {
  private _data: BarColorCandle[] = [];
  private _views: IPrimitivePaneView[] = [new BarColorPaneView(this)];

  setData(data: BarColorCandle[]): void {
    this._data = data;
    this._requestUpdate?.();
  }

  getData() { return this._data; }
  getChart() { return this._chart; }
  getSeries() { return this._series; }

  updateAllViews(): void {}
  paneViews(): readonly IPrimitivePaneView[] { return this._views; }
}

class BarColorPaneView implements IPrimitivePaneView {
  constructor(private _source: BarColorPrimitive) {}
  // Over the real candles — barcolor recolors them.
  zOrder(): 'normal' { return 'normal'; }
  renderer(): IPrimitivePaneRenderer | null { return new BarColorRenderer(this._source); }
}

class BarColorRenderer implements IPrimitivePaneRenderer {
  constructor(private _source: BarColorPrimitive) {}

  draw(target: CanvasRenderingTarget2D): void {
    const chart = this._source.getChart();
    const series = this._source.getSeries();
    if (!chart || !series) return;
    const data = this._source.getData();
    const timeScale = chart.timeScale();

    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const barWidth = getBarWidth(timeScale, mediaSize.width);
      const bodyW = Math.max(1, barWidth * 0.8);
      for (const c of data) {
        const x = timeScale.timeToCoordinate(c.time as unknown as Time);
        if (x == null) continue;
        const yOpen = series.priceToCoordinate(c.open);
        const yClose = series.priceToCoordinate(c.close);
        const yHigh = series.priceToCoordinate(c.high);
        const yLow = series.priceToCoordinate(c.low);
        if (yOpen == null || yClose == null || yHigh == null || yLow == null) continue;
        ctx.strokeStyle = c.color;
        ctx.fillStyle = c.color;
        ctx.lineWidth = 1;
        // Wick, then body — matches lightweight-charts' candle draw order.
        ctx.beginPath();
        ctx.moveTo(x as number, yHigh as number);
        ctx.lineTo(x as number, yLow as number);
        ctx.stroke();
        const top = Math.min(yOpen as number, yClose as number);
        const bottom = Math.max(yOpen as number, yClose as number);
        ctx.fillRect((x as number) - bodyW / 2, top, bodyW, Math.max(1, bottom - top));
      }
    });
  }
}

// ─── Extended markers — shapes beyond lightweight-charts' built-in four ─────
export class ExtendedMarkerPrimitive extends BasePrimitive {
  private _markers: MarkerData[] = [];
  private _views: IPrimitivePaneView[] = [new ExtendedMarkerPaneView(this)];

  setMarkers(markers: MarkerData[]): void {
    this._markers = markers;
    this._requestUpdate?.();
  }

  getMarkers() { return this._markers; }
  getChart() { return this._chart; }
  getSeries() { return this._series; }

  updateAllViews(): void {}
  paneViews(): readonly IPrimitivePaneView[] { return this._views; }
}

class ExtendedMarkerPaneView implements IPrimitivePaneView {
  constructor(private _source: ExtendedMarkerPrimitive) {}
  zOrder(): 'normal' { return 'normal'; }
  renderer(): IPrimitivePaneRenderer | null { return new ExtendedMarkerRenderer(this._source); }
}

class ExtendedMarkerRenderer implements IPrimitivePaneRenderer {
  constructor(private _source: ExtendedMarkerPrimitive) {}

  draw(target: CanvasRenderingTarget2D): void {
    const chart = this._source.getChart();
    const series = this._source.getSeries();
    if (!chart || !series) return;

    const markers = this._source.getMarkers();
    const timeScale = chart.timeScale();

    target.useMediaCoordinateSpace(({ context: ctx }) => {
      for (const marker of markers) {
        const x = timeScale.timeToCoordinate(marker.time as unknown as Time);
        if (x == null) continue;
        const logical = timeScale.coordinateToLogical(x as number);
        if (logical == null) continue;
        const barData = series.dataByIndex(logical);
        if (!barData) continue;

        const bar = barData as { high?: number; low?: number; close?: number; value?: number };
        let baseY: number | null;
        if (marker.position === 'aboveBar') {
          baseY = series.priceToCoordinate(bar.high ?? bar.value ?? 0);
          if (baseY != null) baseY -= 10;
        } else if (marker.position === 'belowBar') {
          baseY = series.priceToCoordinate(bar.low ?? bar.value ?? 0);
          if (baseY != null) baseY += 10;
        } else {
          baseY = series.priceToCoordinate(bar.close ?? bar.value ?? 0);
        }
        if (baseY == null) continue;

        const size = (marker.size ?? 1) * 6;
        ctx.fillStyle = marker.color;
        ctx.strokeStyle = marker.color;
        ctx.lineWidth = 2;
        drawExtendedShape(ctx, marker.shape, x as number, baseY as number, size);

        if (marker.text) {
          ctx.fillStyle = marker.color;
          ctx.font = '11px sans-serif';
          ctx.textAlign = 'center';
          const textY = marker.position === 'aboveBar' ? (baseY as number) - size - 4 : (baseY as number) + size + 12;
          ctx.fillText(marker.text, x as number, textY);
        }
      }
    });
  }
}

function drawExtendedShape(ctx: CanvasRenderingContext2D, shape: string, x: number, y: number, size: number): void {
  switch (shape) {
    case 'triangleUp':
      ctx.beginPath(); ctx.moveTo(x, y - size); ctx.lineTo(x - size, y + size); ctx.lineTo(x + size, y + size); ctx.closePath(); ctx.fill();
      break;
    case 'triangleDown':
      ctx.beginPath(); ctx.moveTo(x, y + size); ctx.lineTo(x - size, y - size); ctx.lineTo(x + size, y - size); ctx.closePath(); ctx.fill();
      break;
    case 'diamond':
      ctx.beginPath(); ctx.moveTo(x, y - size); ctx.lineTo(x + size, y); ctx.lineTo(x, y + size); ctx.lineTo(x - size, y); ctx.closePath(); ctx.fill();
      break;
    case 'cross':
      ctx.beginPath(); ctx.moveTo(x - size, y); ctx.lineTo(x + size, y); ctx.moveTo(x, y - size); ctx.lineTo(x, y + size); ctx.stroke();
      break;
    case 'xcross':
      ctx.beginPath(); ctx.moveTo(x - size, y - size); ctx.lineTo(x + size, y + size); ctx.moveTo(x + size, y - size); ctx.lineTo(x - size, y + size); ctx.stroke();
      break;
    case 'flag':
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y - size * 2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x, y - size * 2); ctx.lineTo(x + size * 1.5, y - size * 1.5); ctx.lineTo(x, y - size); ctx.closePath(); ctx.fill();
      break;
    case 'labelUp':
      ctx.beginPath(); ctx.moveTo(x, y - size * 2); ctx.lineTo(x - size, y - size); ctx.lineTo(x + size, y - size); ctx.closePath(); ctx.fill();
      break;
    case 'labelDown':
      ctx.beginPath(); ctx.moveTo(x, y + size * 2); ctx.lineTo(x - size, y + size); ctx.lineTo(x + size, y + size); ctx.closePath(); ctx.fill();
      break;
  }
}
