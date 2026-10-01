/*
 * Countdown-to-bar-close primitive — the Scales row "Countdown to bar close".
 * The remaining time renders as a second row INSIDE the last-price label,
 * ticking every second. Built on the series-primitive pattern
 * (session-breaks.ts) as a priceAxisPaneViews() plate drawn on the axis
 * canvas (the axis-view API can't do a two-row label).
 *
 * The remaining time is derived from the bar grid (last bar time + interval),
 * not the wall-clock bucket, so session-anchored hour buckets stay aligned,
 * and a bar never runs past its session's close. All session times come from
 * the charted symbol's own sessions (data/session): the daily family counts
 * to the close of the trading day, weekly / monthly show whole days once the
 * horizon exceeds a day.
 */
import type {
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from "lightweight-charts";
import type { CanvasRenderingTarget2D } from "fancy-canvas";
import { localDay, weekdayOf, type SessionId, type SymbolSessions } from "../../data/session";

export type CountdownState = {
  visible: boolean;
  /** Anchor price (the last bar's close — the plate centres its price row here,
   *  where the library's own last-value label would sit). */
  price: number;
  /** Formatted last price — row 1 of the plate (the combined label). Empty
   *  when the Symbol price-label setting is off: the plate then shows only
   *  the countdown row. */
  priceText: string;
  /** Row 2 ("Price and percentage value" mode): change from the first
   *  visible bar; empty otherwise. */
  pctText: string;
  /** Countdown row (empty when the countdown is off). */
  text: string;
  backColor: string;
  textColor: string;
  fontSize: number;
  fontFamily: string;
};

/** Draws the combined last-price label on the price axis: one plate, price
 *  row on top and the countdown row under it (the countdown is a second row
 *  INSIDE the price label, not a separate badge). While this
 *  plate is visible ChartView turns the library's own last-value label off so
 *  the two don't double-draw. */
export class CountdownPrimitive implements ISeriesPrimitive<Time> {
  private _series: ISeriesApi<SeriesType> | null = null;
  private _requestUpdate: (() => void) | null = null;
  private _state: CountdownState = {
    visible: false,
    price: 0,
    priceText: "",
    pctText: "",
    text: "",
    backColor: "#4caf50",
    textColor: "#ffffff",
    fontSize: 12,
    fontFamily: "sans-serif",
  };
  private _views: IPrimitivePaneView[] = [new CountdownPaneView(this)];

  attached(p: SeriesAttachedParameter<Time, SeriesType>): void {
    this._series = p.series;
    this._requestUpdate = p.requestUpdate;
  }
  detached(): void {
    this._series = null;
    this._requestUpdate = null;
  }

  setState(next: CountdownState): void {
    const prev = this._state;
    this._state = next;
    // The 1s timer calls this unconditionally — skip the chart repaint while
    // the label is hidden (token off / no text) both before and after, and
    // when nothing the plate renders actually changed (e.g. a "3d" text
    // that only moves once a day).
    const rows = (x: CountdownState) => x.text.length + x.pctText.length + x.priceText.length;
    const hidden = !next.visible || rows(next) === 0;
    const wasHidden = !prev.visible || rows(prev) === 0;
    if (hidden && wasHidden) return;
    if (
      prev.visible === next.visible &&
      prev.text === next.text &&
      prev.price === next.price &&
      prev.priceText === next.priceText &&
      prev.pctText === next.pctText &&
      prev.backColor === next.backColor &&
      prev.textColor === next.textColor &&
      prev.fontSize === next.fontSize &&
      prev.fontFamily === next.fontFamily
    ) {
      return;
    }
    this._requestUpdate?.();
  }

  getState(): CountdownState {
    return this._state;
  }
  getSeries(): ISeriesApi<SeriesType> | null {
    return this._series;
  }

  updateAllViews(): void {}
  priceAxisPaneViews(): readonly IPrimitivePaneView[] {
    return this._views;
  }
}

class CountdownPaneView implements IPrimitivePaneView {
  private _renderer: CountdownPaneRenderer;
  constructor(source: CountdownPrimitive) {
    this._renderer = new CountdownPaneRenderer(source);
  }
  renderer(): IPrimitivePaneRenderer | null {
    return this._renderer;
  }
  zOrder(): "top" {
    return "top";
  }
}

class CountdownPaneRenderer implements IPrimitivePaneRenderer {
  constructor(private _source: CountdownPrimitive) {}
  draw(target: CanvasRenderingTarget2D): void {
    const s = this._source.getState();
    const rows = [s.priceText, s.pctText, s.text].filter((r) => r.length > 0);
    if (!s.visible || rows.length === 0) return;
    const series = this._source.getSeries();
    const y = series?.priceToCoordinate(s.price);
    if (y == null) return;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const rowH = s.fontSize + 6;
      // Price row centred on the price coordinate — exactly where the
      // library's last-value label sat; the countdown row extends below.
      const top = (y as number) - rowH / 2;
      ctx.fillStyle = s.backColor;
      ctx.fillRect(0, top, mediaSize.width, rowH * rows.length);
      ctx.font = `${s.fontSize}px ${s.fontFamily}`;
      ctx.textBaseline = "middle";
      ctx.textAlign = "left";
      for (let i = 0; i < rows.length; i++) {
        // The third line (countdown) uses the text colour at 25 %
        // transparency; price and percentage rows use it as is.
        const isCountdown = rows[i] === s.text && i === rows.length - 1 && s.text.length > 0;
        ctx.globalAlpha = isCountdown ? 0.75 : 1;
        ctx.fillStyle = s.textColor;
        ctx.fillText(rows[i], 6, top + rowH * i + rowH / 2);
      }
      ctx.globalAlpha = 1;
    });
  }
}

// ── Remaining-time derivation ────────────────────────────────────────────────

/** "H:MM:SS" under a day, "MM:SS" under an hour, whole days above a day. */
function formatRemaining(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  if (s >= 86400) return `${Math.ceil(s / 86400)}d`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const mm = String(m).padStart(2, "0");
  const pad = String(ss).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${pad}` : `${mm}:${pad}`;
}

/** Whole days to a closing trading day, or the clock time on that day. */
function daysOrClock(sessions: SymbolSessions, nowSec: number, closeDay: number): string | null {
  const bounds = sessions.regular.dayBounds(closeDay);
  if (!bounds) return null;
  const days = closeDay - localDay(sessions.timeZone, nowSec);
  return days > 0 ? `${days}d` : formatRemaining(bounds.end - nowSec);
}

/** Remaining time to the current bar's close for an interval id, or null
 *  when no bar is forming: outside the symbol's session (the label then
 *  disappears entirely), sessions not resolved yet, or an interval that takes
 *  no countdown (unknown/custom ids). Intraday bars form across the CHOSEN
 *  session (`session`: regular or extended hours); daily+ bars belong to the
 *  regular session regardless of the toggle. `lastBarSec` is the newest
 *  loaded bar's bucket start (aligns intraday buckets, e.g. session-anchored
 *  hours); intraday falls back to the wall-clock grid without it. */
export function countdownText(
  interval: string,
  nowSec: number,
  lastBarSec: number | undefined,
  session: SessionId,
  sessions: SymbolSessions | null,
): string | null {
  if (!sessions) return null;
  const id = interval.toUpperCase();
  const intraday = /^\d+S$/.test(id) || /^\d+$/.test(id);
  const iv = sessions.spec(intraday ? session : "RTH").at(nowSec);
  if (!iv) return null;
  if (intraday) {
    const step = /S$/.test(id) ? parseInt(id, 10) : parseInt(id, 10) * 60;
    if (!Number.isFinite(step) || step <= 0) return null;
    const base = lastBarSec ?? Math.floor(nowSec / step) * step;
    const into = ((nowSec - base) % step + step) % step;
    // The bar closes with its session interval at the latest.
    return formatRemaining(Math.min(step - into, iv.end - nowSec));
  }
  if (id === "1D") {
    const bounds = sessions.regular.dayBounds(iv.day);
    return bounds ? formatRemaining(bounds.end - nowSec) : null;
  }
  if (id === "1W") {
    // To the close of the week's last trading day (weeks run Monday-Sunday).
    let close = iv.day;
    for (let d = iv.day + 1; weekdayOf(d) !== 2; d++) if (sessions.regular.isTradingDay(d)) close = d;
    return daysOrClock(sessions, nowSec, close);
  }
  if (id === "1M") {
    // Days until the month rolls over on the exchange calendar; the clock
    // time on the month's last day.
    const today = localDay(sessions.timeZone, nowSec);
    const date = new Date(today * 86400000);
    const lastOfMonth = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0) / 86400000;
    const left = lastOfMonth - today;
    return left > 0 ? `${left}d` : daysOrClock(sessions, nowSec, iv.day);
  }
  return null;
}
