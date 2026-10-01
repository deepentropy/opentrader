/*
 * Session-breaks primitive — full-height vertical separators at the start of
 * each trading session ("Session breaks", Events tab). On intraday frames
 * a thin vertical line is drawn on the first bar of each trading day of the
 * chosen session, in the symbol's exchange zone (US extended 04:00, regular
 * 09:30, FX 17:00 the day before, crypto 00:00 UTC; one per day, none after
 * a lunch break), whatever the display time zone — as the reference app's
 * session breaks (observed 01/10/2026). Daily+ frames show nothing.
 *
 * Built on the same series-primitive pattern as the indicator renderers
 * (window/chart/indicators/indicator-primitives.ts): attach to the price series
 * and paint in the chart's media-space 2D context, behind the candles.
 */
import type {
  IChartApi,
  ISeriesPrimitive,
  IPrimitivePaneView,
  IPrimitivePaneRenderer,
  SeriesAttachedParameter,
  Time,
  SeriesType,
} from 'lightweight-charts';
import type { CanvasRenderingTarget2D } from 'fancy-canvas';
import type { SessionSpec } from '../../data/session';

/** Day boundaries (bar times where a new session starts), as UTC seconds. */
export class SessionBreaksPrimitive implements ISeriesPrimitive<Time> {
  private _chart: IChartApi | null = null;
  private _requestUpdate: (() => void) | null = null;

  private _times: number[] = [];
  private _color = 'rgb(73, 133, 231)';
  private _visible = false;
  private _lineStyle = 0; // 0 solid, 1 dashed, 2 dotted
  private _lineWidth = 1;
  private _views: IPrimitivePaneView[] = [new SessionBreaksPaneView(this)];

  attached(p: SeriesAttachedParameter<Time, SeriesType>): void {
    this._chart = p.chart as IChartApi;
    this._requestUpdate = p.requestUpdate;
  }
  detached(): void {
    this._chart = null;
    this._requestUpdate = null;
  }

  /** Update boundaries and/or appearance; triggers a repaint. */
  setData(times: number[], color: string, visible: boolean, lineStyle = 0, lineWidth = 1): void {
    this._times = times;
    this._color = color;
    this._visible = visible;
    this._lineStyle = lineStyle;
    this._lineWidth = lineWidth;
    this._requestUpdate?.();
  }

  getTimes() { return this._times; }
  getColor() { return this._color; }
  getVisible() { return this._visible; }
  getLineStyle() { return this._lineStyle; }
  getLineWidth() { return this._lineWidth; }
  getChart() { return this._chart; }

  updateAllViews(): void {}
  paneViews(): readonly IPrimitivePaneView[] { return this._views; }
}

class SessionBreaksPaneView implements IPrimitivePaneView {
  constructor(private _source: SessionBreaksPrimitive) {}
  // Behind the series, like the chart grid.
  zOrder(): 'bottom' { return 'bottom'; }
  renderer(): IPrimitivePaneRenderer | null { return new SessionBreaksRenderer(this._source); }
}

class SessionBreaksRenderer implements IPrimitivePaneRenderer {
  constructor(private _source: SessionBreaksPrimitive) {}

  draw(target: CanvasRenderingTarget2D): void {
    const chart = this._source.getChart();
    if (!chart || !this._source.getVisible()) return;
    const times = this._source.getTimes();
    if (times.length === 0) return;
    const timeScale = chart.timeScale();
    const color = this._source.getColor();
    const style = this._source.getLineStyle();
    const width = this._source.getLineWidth();

    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      if (style === 1) ctx.setLineDash([4 * width, 4 * width]);
      else if (style === 2) ctx.setLineDash([width, 2 * width]);
      for (const t of times) {
        const x = timeScale.timeToCoordinate(t as unknown as Time);
        if (x == null) continue;
        // Snap to the pixel grid so an odd-width line stays crisp.
        const px = Math.round(x as number) + (width % 2 ? 0.5 : 0);
        ctx.beginPath();
        ctx.moveTo(px, 0);
        ctx.lineTo(px, mediaSize.height);
        ctx.stroke();
      }
      ctx.setLineDash([]);
    });
  }
}

/**
 * Session boundaries for {@link SessionBreaksPrimitive}: the time of every
 * bar whose trading day (in `spec`, the chart's session of the symbol)
 * differs from the previous bar's. Empty on non-intraday frames (one bar
 * already spans a whole session).
 */
export function computeSessionBoundaries(
  bars: ReadonlyArray<{ time: number }>,
  intraday: boolean,
  spec: SessionSpec,
): number[] {
  if (!intraday || bars.length < 2) return [];
  const dayOf = (sec: number) => spec.at(sec)?.day ?? spec.tradingDay(sec);
  const out: number[] = [];
  let prevDay = dayOf(bars[0].time);
  for (let i = 1; i < bars.length; i++) {
    const day = dayOf(bars[i].time);
    if (day !== prevDay) {
      out.push(bars[i].time);
      prevDay = day;
    }
  }
  return out;
}
