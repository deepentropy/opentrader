/*
 * Event lollipops — the Dividends (D), Splits (S) and Earnings (E) markers of
 * the Events tab, along the bottom of the price pane.
 *
 * Reference geometry and styles (dark theme):
 *   • Dividends / Splits: 23 × 23 circle, 1 px above the pane bottom; disc
 *     #0F0F0F, ring 1.5 px in the kind colour (dividends #2962FF, splits
 *     #FF9800), glyph "D" / "S" in the colour. Hovered: disc filled with the
 *     colour at 15 % opacity. Active (card open): disc filled with the colour,
 *     glyph #E3EFFD (dividends) / #FFF3E0 (splits).
 *   • Earnings: 25 × 25 rounded square on the pane bottom, same three states;
 *     without an estimate (the case of every release served) the "unknown"
 *     colour #8C8C8C, glyph "E", active glyph #F9F9F9.
 *   • Several markers on one bar stack upward, 25 px a row: earnings at the
 *     bottom, then splits, then dividends.
 *   • A hovered or active marker shows its bar line: 1 px dashed [5, 6] in its
 *     colour, from the pane top to the marker top. "Earnings breaks" shows it
 *     for every earnings marker.
 *   • Hit box: the marker box (earnings: 2 px inside it); the crosshair lines
 *     hide while a marker is hovered.
 * A marker sits on the bar that holds its date: the bar of that day on daily
 * and intraday charts (its first bar), the week / month bar holding it on
 * coarser ones, the future time axis after the last bar.
 */
import type {
  IChartApi,
  ISeriesPrimitive,
  IPrimitivePaneView,
  IPrimitivePaneRenderer,
  PrimitiveHoveredItem,
  SeriesAttachedParameter,
  Time,
  SeriesType,
} from "lightweight-charts";
import type { CanvasRenderingTarget2D } from "fancy-canvas";
import type { OHLC } from "./chart-types";
import type { ChartEvent } from "../../data/datafeed";
import { timeToXFallback, type FutureAxis } from "../drawings/coords";

export type EventKind = ChartEvent["kind"];
export type EventMarker = ChartEvent;

/** Hovered-object id prefix of a marker (`esd:<index>`). */
export const EVENT_MARKER_PREFIX = "esd:";

type KindStyle = {
  size: number;
  bottom: number;
  color: { dark: string; light: string };
  /** Glyph colour while the card is open. */
  activeText: string;
};

export const EVENT_STYLES: Record<EventKind, KindStyle> = {
  dividend: { size: 23, bottom: 1, color: { dark: "#2962FF", light: "#2962FF" }, activeText: "#E3EFFD" },
  split: { size: 23, bottom: 1, color: { dark: "#FF9800", light: "#FF9800" }, activeText: "#FFF3E0" },
  earnings: { size: 25, bottom: 0, color: { dark: "#8C8C8C", light: "#707070" }, activeText: "#F9F9F9" },
};

/** Stacking order: a marker rises one row per marker of a later kind on its bar. */
const STACK_ORDER: Record<EventKind, number> = { dividend: 0, split: 1, earnings: 2 };
const ROW = 25;
const BG = { dark: "#0F0F0F", light: "#FFFFFF" };

// Glyphs, in the marker box (23 or 25 px, origin top-left).
const DIVIDEND_LABEL = "M14.5 11.5a3 3 0 0 0-3-3h-2v6h2V16H8V7h3.5a4.5 4.5 0 1 1 0 9v-1.5a3 3 0 0 0 3-3";
const SPLIT_LABEL =
  "M9.68 16.66q.77.34 1.82.34 1.07 0 1.86-.37.78-.38 1.21-1.04.43-.67.43-1.6 0-.74-.28-1.25a2 2 0 0 0-.86-.87 5 5 0 0 0-1.54-.56l-.97-.22q-.55-.13-.9-.3a1.3 1.3 0 0 1-.51-.45 1 1 0 0 1-.17-.6q0-.4.22-.7t.61-.45q.39-.16.88-.16.51 0 .9.16t.62.45q.17.2.25.46h1.56q-.08-.66-.45-1.19-.42-.6-1.15-.95A4 4 0 0 0 11.5 7q-.97 0-1.72.36-.76.36-1.18 1t-.42 1.5q0 .7.27 1.25.29.54.86.91.6.37 1.5.58l.96.2q.88.21 1.26.54.37.32.37.83v.01q0 .41-.23.73-.24.3-.65.49-.42.17-.96.17-.57 0-1.01-.16-.45-.17-.71-.47-.18-.2-.25-.44H8q.1.67.47 1.2.45.6 1.21.96";
const EARNINGS_LABEL = "M10 17V8h5.2v1.5h-3.7v2.25h2.7v1.5h-2.7v2.25h3.7V17z";
const EARNINGS_FILL = "M2 5a3 3 0 0 1 3-3h15a3 3 0 0 1 3 3v15a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3z";
const EARNINGS_BORDER = "M5 3.5h15c.83 0 1.5.67 1.5 1.5v15c0 .83-.67 1.5-1.5 1.5H5A1.5 1.5 0 0 1 3.5 20V4.85A1.5 1.5 0 0 1 5 3.5Z";

/** `color` at `alpha` (a #RRGGBB colour). */
function withAlpha(color: string, alpha: number): string {
  const n = parseInt(color.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** First index whose time is ≥ `t` (bars ascending). */
function lowerBound(bars: OHLC[], t: number): number {
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((bars[mid].time as number) < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** One placed marker. */
export type PlacedMarker = { index: number; marker: EventMarker; x: number; cx: number; cy: number; size: number; baseY: number };

export class EventMarkersPrimitive implements ISeriesPrimitive<Time> {
  private _chart: IChartApi | null = null;
  private _requestUpdate: (() => void) | null = null;
  private _paneOf: (() => { getHeight(): number }) | null = null;
  private _markers: EventMarker[] = [];
  private _show: Record<EventKind, boolean> = { dividend: false, split: false, earnings: false };
  private _breaks = false;
  private _dark = true;
  private _hovered: number | null = null;
  private _active: number | null = null;
  /** Bar of a daily-bar stamp is the bar of that day (daily / intraday) or the bar holding it (week / month). */
  private _coarse = false;
  private _getBars: () => OHLC[] = () => [];
  private _getFuture: () => FutureAxis | null = () => null;
  /** Price-based chart types: the bricks and their source bars' real times. */
  private _getBricks: () => { bars: OHLC[]; realTime: Map<number, number> } | null = () => null;
  private _brickTimes: { of: object; times: number[] } | null = null;
  private _paths: Record<string, Path2D> = {};
  private _views: IPrimitivePaneView[] = [new EventMarkersPaneView(this)];

  attached(p: SeriesAttachedParameter<Time, SeriesType>): void {
    this._chart = p.chart as IChartApi;
    this._paneOf = () => p.series.getPane();
    this._requestUpdate = p.requestUpdate;
  }
  detached(): void {
    this._chart = null;
    this._paneOf = null;
    this._requestUpdate = null;
  }

  setData(markers: EventMarker[], show: Record<EventKind, boolean>, earningsBreaks: boolean): void {
    if (markers !== this._markers) {
      this._hovered = null;
      this._active = null;
    }
    this._markers = markers;
    this._show = show;
    this._breaks = earningsBreaks;
    if (this._active !== null && !show[markers[this._active]?.kind ?? "dividend"]) this._active = null;
    this._requestUpdate?.();
  }

  setTheme(dark: boolean): void {
    if (dark === this._dark) return;
    this._dark = dark;
    this._requestUpdate?.();
  }

  /** Week / month bars (a marker takes the bar holding its date). */
  setCoarseBars(coarse: boolean): void {
    if (coarse === this._coarse) return;
    this._coarse = coarse;
    this._requestUpdate?.();
  }

  setHovered(index: number | null): void {
    if (index === this._hovered) return;
    this._hovered = index;
    this._requestUpdate?.();
  }
  setActive(index: number | null): void {
    if (index === this._active) return;
    this._active = index;
    this._requestUpdate?.();
  }
  hovered(): number | null { return this._hovered; }
  active(): number | null { return this._active; }
  marker(index: number): EventMarker | undefined { return this._markers[index]; }

  /** Live accessor to the chart's bars (bar of a marker's date). */
  setBarsAccessor(getBars: () => OHLC[]): void { this._getBars = getBars; }
  /** Bricks of a price-based chart type (null on time-based types). */
  setBricksAccessor(get: () => { bars: OHLC[]; realTime: Map<number, number> } | null): void { this._getBricks = get; }
  /** Future bars of the chart on the trading calendar, for a date after the last bar. */
  setFutureAccessor(getFuture: () => FutureAxis | null): void { this._getFuture = getFuture; }

  dark(): boolean { return this._dark; }
  breaks(): boolean { return this._breaks; }
  path(d: string): Path2D { return (this._paths[d] ??= new Path2D(d)); }

  /** Height of the series' pane (the price pane, at any position). */
  paneHeight(): number {
    try { return this._paneOf?.().getHeight() ?? 0; } catch { return 0; }
  }

  /** x of the bar holding `time`, or null when it cannot be placed. */
  private _x(time: number): number | null {
    const chart = this._chart;
    if (!chart) return null;
    const ts = chart.timeScale();
    // Price-based types: the first brick dated on or after the event (reference
    // app); none after the last brick.
    const bricks = this._getBricks();
    if (bricks) {
      if (this._brickTimes?.of !== bricks) this._brickTimes = { of: bricks, times: bricks.bars.map((b) => bricks.realTime.get(b.time as number) ?? (b.time as number)) };
      const times = this._brickTimes.times;
      let lo = 0;
      let hi = times.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (times[mid] < time) lo = mid + 1;
        else hi = mid;
      }
      const brick = bricks.bars[lo];
      return brick ? (ts.timeToCoordinate(brick.time as Time) as number | null) : null;
    }
    const exact = ts.timeToCoordinate(time as unknown as Time);
    if (exact !== null) return exact as number;
    const bars = this._getBars();
    if (bars.length > 0 && time >= (bars[0].time as number) && time <= (bars[bars.length - 1].time as number)) {
      // Coarse bars: the bar holding the date; finer ones: the first bar of the day.
      const i = lowerBound(bars, time);
      const bar = this._coarse ? bars[(bars[i]?.time as number) === time ? i : i - 1] : bars[i];
      if (bar) {
        const x = ts.timeToCoordinate(bar.time as Time);
        if (x !== null) return x as number;
      }
    }
    if (bars.length > 0 && time < (bars[0].time as number)) return null;
    return timeToXFallback(chart, time, bars, this._getFuture());
  }

  /** The shown markers with their place, for the current view (pane media coordinates). */
  placed(paneHeight = this.paneHeight()): PlacedMarker[] {
    const out: PlacedMarker[] = [];
    if (!this._chart || paneHeight <= 0) return out;
    const width = this._chart.timeScale().width();
    const byX = new Map<number, PlacedMarker[]>();
    this._markers.forEach((marker, index) => {
      if (!this._show[marker.kind]) return;
      const x = this._x(marker.time);
      if (x === null || x < -ROW || x > width + ROW) return;
      const st = EVENT_STYLES[marker.kind];
      const p: PlacedMarker = { index, marker, x, cx: x, cy: 0, size: st.size, baseY: paneHeight };
      const key = Math.round(x);
      const list = byX.get(key) ?? [];
      list.push(p);
      byX.set(key, list);
      out.push(p);
    });
    for (const list of byX.values()) {
      for (const p of list) {
        const st = EVENT_STYLES[p.marker.kind];
        const stack = list.filter((q) => STACK_ORDER[q.marker.kind] > STACK_ORDER[p.marker.kind]).length;
        p.cy = paneHeight - st.bottom - st.size / 2 - stack * ROW;
      }
    }
    // Paint order: dividends, then splits, then earnings on top (the reference sources' order).
    return out.sort((a, b) => STACK_ORDER[a.marker.kind] - STACK_ORDER[b.marker.kind] || a.marker.time - b.marker.time);
  }

  /** Index of the marker under (x, y) (pane media coordinates), or null. */
  markerAt(x: number, y: number): number | null {
    // The marker drawn last (on top) wins.
    const list = this.placed();
    for (let i = list.length - 1; i >= 0; i--) {
      const p = list[i];
      const half = p.size / 2 - (p.marker.kind === "earnings" ? 2 : 0);
      if (Math.abs(x - p.cx) <= half && Math.abs(y - p.cy) <= half) return p.index;
    }
    return null;
  }

  hitTest(x: number, y: number): PrimitiveHoveredItem | null {
    const i = this.markerAt(x, y);
    if (i === null) return null;
    return { externalId: `${EVENT_MARKER_PREFIX}${i}`, zOrder: "top", cursorStyle: "default", hitTestPriority: 2 };
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
    target.useBitmapCoordinateSpace(({ context: ctx, horizontalPixelRatio: hpr, verticalPixelRatio: vpr, mediaSize }) => {
      const src = this._source;
      const placed = src.placed(mediaSize.height);
      if (placed.length === 0) return;
      const dark = src.dark();
      const bg = dark ? BG.dark : BG.light;
      const hx = (Math.max(1, Math.floor(hpr)) % 2) / 2;
      const vy = (Math.max(1, Math.floor(vpr)) % 2) / 2;
      // Bar lines first: under every marker.
      for (const p of placed) {
        const st = EVENT_STYLES[p.marker.kind];
        const state = p.index === src.active() ? "active" : p.index === src.hovered() ? "hovered" : "default";
        if (state === "default" && !(p.marker.kind === "earnings" && src.breaks())) continue;
        const color = dark ? st.color.dark : st.color.light;
        const lw = Math.max(1, Math.floor(hpr));
        ctx.save();
        ctx.lineCap = "butt";
        ctx.strokeStyle = color;
        ctx.lineWidth = lw;
        ctx.setLineDash([5 * lw, 6 * lw]);
        const x = Math.round(p.x * hpr) + (lw % 2 ? 0.5 : 0);
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, Math.ceil((p.baseY - st.bottom - st.size) * vpr));
        ctx.stroke();
        ctx.restore();
      }
      for (const p of placed) {
        const kind = p.marker.kind;
        const st = EVENT_STYLES[kind];
        const color = dark ? st.color.dark : st.color.light;
        const state = p.index === src.active() ? "active" : p.index === src.hovered() ? "hovered" : "default";
        const fill = state === "active" ? color : state === "hovered" ? withAlpha(color, 0.15) : null;
        const text = state === "active" ? st.activeText : color;
        const w = st.size;
        // Marker box → bitmap: translate(hx, -vy) · scale(hpr, vpr) · translate(centre - size / 2).
        const e = hx + (p.cx - w / 2) * hpr;
        const f = -vy + (p.cy - w / 2) * vpr;
        ctx.save();
        try {
          if (kind === "earnings") {
            ctx.setTransform(hpr, 0, 0, vpr, e, f);
            ctx.fillStyle = bg;
            ctx.fill(src.path(EARNINGS_FILL));
            if (fill) {
              ctx.fillStyle = fill;
              ctx.fill(src.path(EARNINGS_BORDER));
            }
            ctx.lineWidth = 1.5;
            ctx.setLineDash([]);
            ctx.strokeStyle = color;
            ctx.stroke(src.path(EARNINGS_BORDER));
            ctx.fillStyle = text;
            ctx.fill(src.path(EARNINGS_LABEL));
          } else {
            const cx = Math.round(p.cx * hpr) + hx;
            const cy = Math.round(p.cy * vpr) - vy;
            const minPx = Math.max(1, Math.floor(hpr));
            let d = Math.round(w * hpr);
            if (d % 2 !== minPx % 2) d += 1;
            const outer = d / 2;
            const lw = Math.round(1.5 * hpr);
            const inner = outer - Math.round(1 * hpr + lw / 2);
            ctx.fillStyle = bg;
            ctx.beginPath();
            ctx.arc(cx, cy, outer, 0, 2 * Math.PI);
            ctx.fill();
            if (fill) {
              ctx.fillStyle = fill;
              ctx.beginPath();
              ctx.arc(cx, cy, inner, 0, 2 * Math.PI);
              ctx.fill();
            }
            ctx.strokeStyle = color;
            ctx.lineWidth = lw;
            ctx.setLineDash([]);
            ctx.beginPath();
            ctx.arc(cx, cy, inner, 0, 2 * Math.PI);
            ctx.stroke();
            ctx.setTransform(hpr, 0, 0, vpr, e, f);
            ctx.fillStyle = text;
            ctx.fill(src.path(kind === "dividend" ? DIVIDEND_LABEL : SPLIT_LABEL));
          }
        } finally {
          ctx.restore();
        }
      }
    });
  }
}
