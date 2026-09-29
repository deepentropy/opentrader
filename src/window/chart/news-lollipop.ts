/*
 * Latest news lollipop — TV LatestUpdatesSource (module 681199) + its base
 * LollipopPaneView / LollipopRenderer (776072 / 515255), read 26/09/2026.
 *
 * One lightning lollipop on the LAST bar, 2 px above the bottom of the price
 * pane, while the newest headline is less than 31 days old (TV MonthDiff).
 * Dark theme colours: background #0F0F0F (cold-gray-900), foreground #AB47BC
 * (grapes-purple-400), active icon #EDE7F6 (deep-blue-50), "new items" dot
 * #F23645 (ripe-red-500).
 *   default: ring r 11 (1 px, background) · disc r 10.5 background ·
 *            lightning icon foreground · border r 9.75 (1.5 px, foreground)
 *   hovered: disc = background blended with foreground at 15 %
 *   active (card open): disc foreground, icon #EDE7F6, no border
 *   hovered or active: dashed bar line (1 px, [5, 6]) from the pane top to
 *   the lollipop top, foreground.
 * Hit box = the 21 × 21 lollipop box (mouse tolerance 0).
 */
import type {
  ISeriesPrimitive,
  IPrimitivePaneView,
  IPrimitivePaneRenderer,
  PrimitiveHoveredItem,
  SeriesAttachedParameter,
  Time,
  SeriesType,
  IChartApi,
} from "lightweight-charts";
import type { CanvasRenderingTarget2D } from "fancy-canvas";

export const NEWS_LOLLIPOP_ID = "news-lollipop";

/** Lollipop size (TV style.lollipop width/height) and its gap to the pane bottom. */
const SIZE = 21;
const BOTTOM = 2;
/** TV MonthDiff: history older than this shows no lollipop. */
export const NEWS_MAX_AGE_MS = 26784e5;
/** TV UpdateFrequency: the news thread refreshes every 5 minutes. */
export const NEWS_UPDATE_MS = 3e5;

const BG = "#0F0F0F";
const FG = "#AB47BC";
const ACTIVE_ICON = "#EDE7F6";
const NEW_DOT = "#F23645";
/** TV hovered disc: blendColors(bg, applyAlpha(fg, 0.15)) over #0F0F0F. */
const HOVER_BG = "rgb(38, 23, 41)";

/** Lightning icon (TV path D), drawn at (-4.5, -5.5) from the centre. */
const ICON = "m7.06 0 .87.77-3.4 4.17H9L1.94 11l-.87-.77 3.4-4.17H0L7.06 0Z";

export type NewsLollipopState = { visible: boolean; hovered: boolean; active: boolean; hasNew: boolean };

export class NewsLollipopPrimitive implements ISeriesPrimitive<Time> {
  private _chart: IChartApi | null = null;
  private _requestUpdate: (() => void) | null = null;
  private _lastTime: () => number | null = () => null;
  private _state: NewsLollipopState = { visible: false, hovered: false, active: false, hasNew: false };
  private _icon: Path2D | null = null;
  private _views: IPrimitivePaneView[] = [new NewsLollipopPaneView(this)];

  attached(p: SeriesAttachedParameter<Time, SeriesType>): void {
    this._chart = p.chart as IChartApi;
    this._requestUpdate = p.requestUpdate;
  }
  detached(): void {
    this._chart = null;
    this._requestUpdate = null;
  }

  /** Time of the last bar (the lollipop's bar). */
  setLastTimeAccessor(fn: () => number | null): void { this._lastTime = fn; }

  setState(patch: Partial<NewsLollipopState>): void {
    const next = { ...this._state, ...patch };
    const s = this._state;
    if (next.visible === s.visible && next.hovered === s.hovered && next.active === s.active && next.hasNew === s.hasNew) return;
    this._state = next;
    this._requestUpdate?.();
  }
  state(): NewsLollipopState { return this._state; }

  /** Centre of the lollipop in pane (media) coordinates, or null when hidden
   *  or off screen. `paneHeight` = height of the price pane. */
  center(paneHeight: number): { x: number; y: number } | null {
    if (!this._state.visible || !this._chart) return null;
    const t = this._lastTime();
    if (t === null) return null;
    const x = this._chart.timeScale().timeToCoordinate(t as Time);
    if (x === null) return null;
    return { x: x as number, y: paneHeight - BOTTOM - SIZE / 2 };
  }

  paneHeight(): number { return this._chart ? this._chart.paneSize(0).height : 0; }

  icon(): Path2D { return (this._icon ??= new Path2D(ICON)); }

  updateAllViews(): void {}
  paneViews(): readonly IPrimitivePaneView[] { return this._views; }

  hitTest(x: number, y: number): PrimitiveHoveredItem | null {
    const c = this.center(this.paneHeight());
    if (!c) return null;
    if (Math.abs(x - c.x) > SIZE / 2 || Math.abs(y - c.y) > SIZE / 2) return null;
    return { externalId: NEWS_LOLLIPOP_ID, zOrder: "top", cursorStyle: "default", hitTestPriority: 2 };
  }
}

class NewsLollipopPaneView implements IPrimitivePaneView {
  constructor(private _source: NewsLollipopPrimitive) {}
  zOrder(): "top" { return "top"; }
  renderer(): IPrimitivePaneRenderer | null { return new NewsLollipopRenderer(this._source); }
}

class NewsLollipopRenderer implements IPrimitivePaneRenderer {
  constructor(private _source: NewsLollipopPrimitive) {}

  draw(target: CanvasRenderingTarget2D): void {
    target.useBitmapCoordinateSpace(({ context: ctx, horizontalPixelRatio: hpr, verticalPixelRatio: vpr, mediaSize }) => {
      const c = this._source.center(mediaSize.height);
      if (!c) return;
      const st = this._source.state();
      // TV LollipopRenderer.draw: pixel-aligned centre.
      const cx = Math.round(c.x * hpr) + (Math.max(1, Math.floor(hpr)) % 2) / 2;
      const cy = Math.round(c.y * vpr) - (Math.max(1, Math.floor(vpr)) % 2) / 2;
      if (st.hovered || st.active) {
        // Bar line: pane top → lollipop top (TV VerticalLineRenderer, dashed).
        const x = Math.round(c.x * hpr) + 0.5;
        ctx.save();
        ctx.strokeStyle = FG;
        ctx.lineWidth = Math.max(1, Math.floor(hpr));
        ctx.setLineDash([5 * hpr, 6 * hpr]);
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, (mediaSize.height - BOTTOM - SIZE) * vpr);
        ctx.stroke();
        ctx.restore();
      }
      ctx.save();
      try {
        ctx.translate(cx, cy);
        ctx.scale(hpr, vpr);
        ctx.beginPath();
        ctx.strokeStyle = BG;
        ctx.lineWidth = 1;
        ctx.arc(0, 0, 11, 0, 2 * Math.PI);
        ctx.stroke();
        ctx.fillStyle = st.active ? FG : st.hovered ? HOVER_BG : BG;
        ctx.beginPath();
        ctx.arc(0, 0, 10.5, 0, 2 * Math.PI);
        ctx.fill();
        ctx.translate(-4.5, -5.5);
        ctx.fillStyle = st.active ? ACTIVE_ICON : FG;
        ctx.fill(this._source.icon(), "evenodd");
        ctx.translate(4.5, 5.5);
        if (!st.active) {
          ctx.strokeStyle = FG;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(0, 0, 9.75, 0, 2 * Math.PI);
          ctx.stroke();
        }
        if (st.hasNew) {
          ctx.fillStyle = NEW_DOT;
          ctx.strokeStyle = BG;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(9.75 * Math.cos(Math.PI / 4), -9.75 * Math.sin(Math.PI / 4), 3.5, 0, 2 * Math.PI);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
        }
      } finally {
        ctx.restore();
      }
    });
  }
}

/** TV AgoDateFormatter (module 892659 formatTime, style "long",
 *  numeric "auto"): "2 hours ago", "yesterday", "3 days ago"… */
export function formatAgo(eventMs: number, nowMs: number): string {
  const diffSec = Math.floor((eventMs - nowMs) / 1000);
  const sign = Math.sign(diffSec);
  const e = Math.abs(diffSec);
  let v: number;
  let unit: Intl.RelativeTimeFormatUnit;
  if (e < 90) [v, unit] = [1, "minute"];
  else if (e < 2700) [v, unit] = [Math.max(Math.floor(e / 60), 2), "minute"];
  else if (e < 5400) [v, unit] = [1, "hour"];
  else if (e < 79200) [v, unit] = [Math.max(Math.floor(e / 3600), 2), "hour"];
  else if (e < 129600) [v, unit] = [1, "day"];
  else if (e < 2160000) [v, unit] = [Math.max(Math.floor(e / 86400), 2), "day"];
  else if (e < 3888000) [v, unit] = [1, "month"];
  else if (e < 29808000) [v, unit] = [Math.max(Math.floor(e / 2592000), 2), "month"];
  else if (e < 47088000) [v, unit] = [1, "year"];
  else [v, unit] = [Math.max(Math.floor(e / 31536000), 2), "year"];
  return new Intl.RelativeTimeFormat("en", { numeric: "auto", style: "long" }).format(sign * v, unit);
}

/** TV relative-time title: "Sep 25, 2026, 14:30 GMT+2" style full date. */
export function formatNewsDate(ms: number): string {
  return new Intl.DateTimeFormat("en-u-hc-h23", {
    year: "numeric", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", calendar: "gregory", timeZoneName: "short",
  }).format(new Date(ms));
}
