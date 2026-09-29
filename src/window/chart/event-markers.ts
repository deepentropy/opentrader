/*
 * Event-markers primitive — small D / S badges along the bottom of the pane for
 * Dividends and Splits (Events tab). Drawn at timeScale.timeToCoordinate(date)
 * so a marker lands on its calendar date even when no bar sits exactly there.
 *
 * Same series-primitive pattern as session-breaks.ts / the indicator renderers.
 */
import type {
  IChartApi,
  ISeriesPrimitive,
  IPrimitivePaneView,
  IPrimitivePaneRenderer,
  SeriesAttachedParameter,
  Time,
  SeriesType,
} from "lightweight-charts";
import type { CanvasRenderingTarget2D } from "fancy-canvas";
import type { OHLC } from "./chart-types";
import { timeToXFallback } from "../drawings/coords";

export type EventMarker = { time: number; kind: "dividend" | "split"; label: string };

// Badge colours (chosen — TV-ish: dividend teal, split blue-violet).
const COLORS = { dividend: "rgb(38, 166, 154)", split: "rgb(103, 58, 183)" };

export class EventMarkersPrimitive implements ISeriesPrimitive<Time> {
  private _chart: IChartApi | null = null;
  private _requestUpdate: (() => void) | null = null;
  private _markers: EventMarker[] = [];
  private _showDividends = false;
  private _showSplits = false;
  private _getBars: () => OHLC[] = () => [];
  private _views: IPrimitivePaneView[] = [new EventMarkersPaneView(this)];

  attached(p: SeriesAttachedParameter<Time, SeriesType>): void {
    this._chart = p.chart as IChartApi;
    this._requestUpdate = p.requestUpdate;
  }
  detached(): void {
    this._chart = null;
    this._requestUpdate = null;
  }

  setData(markers: EventMarker[], showDividends: boolean, showSplits: boolean): void {
    this._markers = markers;
    this._showDividends = showDividends;
    this._showSplits = showSplits;
    this._requestUpdate?.();
  }

  /** Live accessor to the chart's bars — used to position a marker whose date
   *  doesn't land exactly on a bar (the off-bar fallback). */
  setBarsAccessor(getBars: () => OHLC[]): void { this._getBars = getBars; }

  getChart() { return this._chart; }
  getBars() { return this._getBars(); }
  getMarkers() { return this._markers; }
  visibleKind(kind: "dividend" | "split") {
    return kind === "dividend" ? this._showDividends : this._showSplits;
  }

  updateAllViews(): void {}
  paneViews(): readonly IPrimitivePaneView[] { return this._views; }
}

class EventMarkersPaneView implements IPrimitivePaneView {
  constructor(private _source: EventMarkersPrimitive) {}
  zOrder(): "top" { return "top"; }
  renderer(): IPrimitivePaneRenderer | null { return new EventMarkersRenderer(this._source); }
}

class EventMarkersRenderer implements IPrimitivePaneRenderer {
  constructor(private _source: EventMarkersPrimitive) {}

  draw(target: CanvasRenderingTarget2D): void {
    const chart = this._source.getChart();
    if (!chart) return;
    const markers = this._source.getMarkers();
    if (markers.length === 0) return;
    const timeScale = chart.timeScale();

    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const r = 7;
      const y = mediaSize.height - r - 4; // hug the bottom, above the time axis
      ctx.font = "bold 9px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const bars = this._source.getBars();
      for (const m of markers) {
        if (!this._source.visibleKind(m.kind)) continue;
        // Exact bar first; otherwise the gap-aware fallback so an ex-div/split
        // date that doesn't sit on a bar (weekends, intraday frames) still lands
        // on its calendar position instead of vanishing.
        const exact = timeScale.timeToCoordinate(m.time as unknown as Time);
        const x = exact != null ? (exact as number) : timeToXFallback(chart, m.time, bars);
        if (x == null) continue;
        const cx = x;
        ctx.fillStyle = COLORS[m.kind];
        ctx.beginPath();
        ctx.arc(cx, y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#ffffff";
        ctx.fillText(m.kind === "dividend" ? "D" : "S", cx, y + 0.5);
      }
    });
  }
}
