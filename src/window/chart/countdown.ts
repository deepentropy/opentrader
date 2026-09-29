/*
 * Countdown-to-bar-close primitive — the Scales row "Countdown to bar close".
 * TV renders the remaining time as a second row INSIDE the last-price label,
 * ticking every second. Built on the series-primitive pattern
 * (session-breaks.ts) as a priceAxisPaneViews() plate drawn on the axis
 * canvas (the axis-view API can't do a two-row label).
 *
 * The remaining time is derived from the bar grid (last bar time + interval),
 * not the wall-clock bucket, so RTH-anchored hour buckets stay aligned; the
 * daily family counts to the 16:00 ET session close (next trading weekday
 * when past close), and weekly/monthly show whole days once the horizon
 * exceeds a day (holidays are not modelled — weekend-only skips).
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

export type CountdownState = {
  visible: boolean;
  /** Anchor price (the last bar's close — the plate centres its price row here,
   *  where the library's own last-value label would sit). */
  price: number;
  /** Formatted last price — row 1 of the plate (TV's combined label). Empty
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

/** Draws TV's combined last-price label on the price axis: one plate, price
 *  row on top and the countdown row under it (TV renders the countdown as a
 *  second row INSIDE the price label, not as a separate badge). While this
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
        // TV's third line (countdown) uses the text colour at 25 %
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

const ET = "America/New_York";
const etParts = new Intl.DateTimeFormat("en-US", {
  timeZone: ET,
  hour12: false,
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** ET weekday (0=Sun..6=Sat) + seconds since ET midnight for a UNIX time. */
function etClock(sec: number): { dow: number; secOfDay: number } {
  const parts = etParts.formatToParts(new Date(sec * 1000));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  let h = +get("hour");
  if (h === 24) h = 0;
  return {
    dow: Math.max(0, days.indexOf(get("weekday"))),
    secOfDay: h * 3600 + +get("minute") * 60 + +get("second"),
  };
}

const SESSION_OPEN = 9 * 3600 + 30 * 60; // 09:30 ET
const SESSION_CLOSE = 16 * 3600; // 16:00 ET
const ETH_OPEN = 4 * 3600; // 04:00 ET (datafeed's extended window)
const ETH_CLOSE = 20 * 3600; // 20:00 ET

/** TV shows the countdown only while a bar is forming — with the market
 *  closed the label disappears entirely (desktop capture 25/07/2026: closed
 *  market, showCountdown on, no label on any interval). Intraday bars form
 *  across the CHOSEN session's hours (ETH 04:00-20:00), so the gate follows
 *  the bottom-bar session toggle; holidays are not modelled (same limitation
 *  as the daily walk). */
function isSessionOpen(nowSec: number, session: "RTH" | "ETH"): boolean {
  const { dow, secOfDay } = etClock(nowSec);
  if (dow < 1 || dow > 5) return false;
  const open = session === "ETH" ? ETH_OPEN : SESSION_OPEN;
  const close = session === "ETH" ? ETH_CLOSE : SESSION_CLOSE;
  return secOfDay >= open && secOfDay < close;
}

/** Seconds until the next regular-session close (16:00 ET), skipping
 *  weekends. Holiday closures are not modelled. */
function secondsToNextDailyClose(nowSec: number): number {
  const { dow, secOfDay } = etClock(nowSec);
  if (dow >= 1 && dow <= 5 && secOfDay < SESSION_CLOSE) return SESSION_CLOSE - secOfDay;
  // Past close (or weekend): walk to the next weekday's close. Calendar-day
  // steps of 86400s — off by an hour across a DST transition, acceptable for
  // a countdown label.
  let days = 1;
  while (((dow + days) % 7) === 0 || ((dow + days) % 7) === 6) days++;
  return days * 86400 - secOfDay + SESSION_CLOSE;
}

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

/** Remaining time to the current bar's close for a TV interval id, or null
 *  when the interval takes no countdown (unknown/custom ids). `lastBarSec` is
 *  the newest loaded bar's bucket start (aligns intraday buckets, e.g.
 *  RTH-anchored hours); intraday falls back to the wall-clock grid without
 *  it. */
export function countdownText(
  interval: string,
  nowSec: number,
  lastBarSec: number | undefined,
  session: "RTH" | "ETH" = "RTH",
): string | null {
  const id = interval.toUpperCase();
  const intraday = /^\d+S$/.test(id) || /^\d+$/.test(id);
  // Daily+ bars belong to the regular session regardless of the toggle.
  if (!isSessionOpen(nowSec, intraday ? session : "RTH")) return null;
  if (intraday) {
    const step = /S$/.test(id) ? parseInt(id, 10) : parseInt(id, 10) * 60;
    if (!Number.isFinite(step) || step <= 0) return null;
    const base = lastBarSec ?? Math.floor(nowSec / step) * step;
    const into = ((nowSec - base) % step + step) % step;
    return formatRemaining(step - into);
  }
  if (id === "1D") return formatRemaining(secondsToNextDailyClose(nowSec));
  if (id === "1W") {
    // Days until the Friday session close (H:MM:SS on Friday itself).
    const { dow } = etClock(nowSec);
    const toClose = secondsToNextDailyClose(nowSec);
    if (dow === 5 && toClose < 86400) return formatRemaining(toClose);
    const daysToFri = (5 - dow + 7) % 7 || 7;
    return `${daysToFri}d`;
  }
  if (id === "1M") {
    // Days until the month rolls over on the ET calendar.
    const d = new Date(nowSec * 1000);
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: ET, year: "numeric", month: "2-digit", day: "2-digit",
    });
    const [y, m, day] = fmt.format(d).split("-").map(Number);
    const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const left = daysInMonth - day;
    return left > 0 ? `${left}d` : formatRemaining(secondsToNextDailyClose(nowSec));
  }
  return null;
}
