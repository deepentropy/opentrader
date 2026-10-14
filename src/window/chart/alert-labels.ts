/*
 * Alert labels — the line, the price-scale tab and the hover / selection label
 * of an alert whose condition is one level (a value) or a channel between two
 * values, drawn on the series the alert reads (the main series, or a study's
 * plot in its own pane and scale).
 *
 * Reference rules (its alert label source):
 *  - line: dashed, 1 px, across the pane when the "Alert lines" setting is on;
 *    with the setting off, a hovered / selected label draws its line from the
 *    scale to the label (one level) or to the connector (a channel);
 *  - colour: the setting's colour; a stopped alert cold-gray-600 (dark) /
 *    cold-gray-300 (light);
 *  - scale: a 7 x 13 tab in the line colour at the outer edge; hovered or
 *    selected, the price label with an alarm clock instead;
 *  - hovered or selected: a vertical connector between the two lines of a
 *    channel 37 px from the scale, a handle on each line there, and a label
 *    47 px (one level) / 62 px (a channel) from the scale: 19 px high, radius
 *    4, the alert's name or message in 12 px, " • Stopped — <reason>" after it
 *    when it fits, a 26 px button that deletes the alert (a cross) or
 *    restarts a stopped one; with the line setting on the label is centred in
 *    the pane (left of the scale-side position when that is further left);
 *  - a fire: the label blinks for 2.4 s (600 ms fades).
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

/** One alert on this series. */
export type AlertLabelSpec = {
  id: string;
  /** One level, or the upper and lower bounds of a channel. */
  levels: number[];
  /** The alert's name, else its message. */
  text: string;
  /** "Stopped — Triggered" etc. for a stopped alert, else null. */
  status: string | null;
  statusColor: string | null;
  /** Line / tab colour. */
  color: string;
  inactive: boolean;
};

export type AlertLabelHit = { id: string; level: number; area: "line" | "tooltip" | "button" | "axis" };

export type AlertLabelsState = {
  labels: AlertLabelSpec[];
  /** "Alert lines" setting: the lines across the pane. */
  lineVisible: boolean;
  hovered: AlertLabelHit | null;
  selected: { id: string; level: number } | null;
  /** Levels shown while a line is dragged. */
  moving: { id: string; levels: number[] } | null;
  /** Labels blinking after a fire: id -> start (performance.now()). */
  blinks: Record<string, number>;
  dark: boolean;
  fontFamily: string;
  /** Side of the scale the series uses. */
  side: "left" | "right";
};

/** Distances from the scale side of the pane (reference). */
export const ALERT_CONNECTOR_X = 37;
const TOOLTIP_X_ONE = 47;
const TOOLTIP_X_TWO = 62;
const TOOLTIP_H = 19;
const TOOLTIP_PAD = 8;
const BUTTON_W = 26;
const FONT_PX = 12;
const SEP = " • ";
export const ALERT_LINE_TOLERANCE = 4;
/** Collapsed scale tab: a rounded triangle 7 x 13 at the outer edge. */
const TAB = "M6.21 5.27 1.68 1.06A1 1 0 0 0 0 1.79v8.42a1 1 0 0 0 1.68.73l4.53-4.2a1 1 0 0 0 0-1.47Z";
const TAB_H = 13;
const BLINK_MS = 2400;

const DARK = {
  inactive: "#636363", // cold-gray-600
  inactiveText: "#8c8c8c", // cold-gray-450
  back: "#0f0f0f", // cold-gray-900
  icon: "#0f0f0f",
  restartIcon: "#dbdbdb", // cold-gray-200
  buttonBorder: "#2e2e2e", // cold-gray-800
};
const LIGHT = {
  inactive: "#b8b8b8", // cold-gray-300
  inactiveText: "#707070", // cold-gray-550
  back: "#ffffff",
  icon: "#ffffff",
  restartIcon: "#0f0f0f",
  buttonBorder: "#f2f2f2", // cold-gray-100
};
/** Colours of the reason after "Stopped —". */
export const ALERT_STATUS_COLORS = { triggered: "#ff9800", manual: null as string | null, expired: "#f23645" };

export function alertLabelTheme(dark: boolean) {
  return dark ? DARK : LIGHT;
}

/** Opacity of a blinking label at `t` ms after the fire (reference: two 1.2 s
 *  periods, each a 600 ms fade one way then the other). */
export function blinkAlpha(t: number, active: boolean): number | null {
  if (t >= BLINK_MS) return null;
  const s = Math.min(t, BLINK_MS) % 1200;
  const r = s % 600;
  const o = Math.round(s / 1200);
  const n = r / 600;
  return (o === 0) === !active ? n : 1 - n;
}

type Geometry = {
  /** Pane width (media px). */
  width: number;
  ys: number[];
  tooltip: { x: number; y: number; w: number; text: string; withStatus: boolean } | null;
};

export class AlertLabelsPrimitive implements ISeriesPrimitive<Time> {
  private _series: ISeriesApi<SeriesType> | null = null;
  private _requestUpdate: (() => void) | null = null;
  private _state: AlertLabelsState = {
    labels: [],
    lineVisible: true,
    hovered: null,
    selected: null,
    moving: null,
    blinks: {},
    dark: true,
    fontFamily: "sans-serif",
    side: "right",
  };
  private _measure: CanvasRenderingContext2D | null = null;
  private _paneViews: IPrimitivePaneView[] = [{ renderer: () => this._paneRenderer, zOrder: () => "top" }];
  private _axisViews: IPrimitivePaneView[] = [{ renderer: () => this._axisRenderer, zOrder: () => "top" }];
  private _paneRenderer: IPrimitivePaneRenderer = { draw: (t) => this.drawPane(t) };
  private _axisRenderer: IPrimitivePaneRenderer = { draw: (t) => this.drawAxis(t) };

  attached(p: SeriesAttachedParameter<Time, SeriesType>): void {
    this._series = p.series;

    this._requestUpdate = p.requestUpdate;
  }
  detached(): void {
    this._series = null;

    this._requestUpdate = null;
  }
  series(): ISeriesApi<SeriesType> | null {
    return this._series;
  }
  state(): AlertLabelsState {
    return this._state;
  }
  setState(patch: Partial<AlertLabelsState>): void {
    this._state = { ...this._state, ...patch };
    this._requestUpdate?.();
  }
  /** Repaint (blinks). */
  update(): void {
    this._requestUpdate?.();
  }
  updateAllViews(): void {}
  paneViews(): readonly IPrimitivePaneView[] {
    return this._paneViews;
  }
  priceAxisPaneViews(): readonly IPrimitivePaneView[] {
    return this._axisViews;
  }

  private levelsOf(l: AlertLabelSpec): number[] {
    const m = this._state.moving;
    return m && m.id === l.id ? m.levels : l.levels;
  }
  private isActive(id: string): boolean {
    return this._state.hovered?.id === id || this._state.selected?.id === id;
  }
  private activeLevel(id: string): number {
    const s = this._state;
    if (s.selected?.id === id) return s.selected.level;
    return s.hovered?.id === id ? s.hovered.level : 0;
  }
  private textWidth(text: string): number {
    if (!this._measure) this._measure = document.createElement("canvas").getContext("2d");
    const m = this._measure!;
    m.font = `${FONT_PX}px ${this._state.fontFamily}`;
    return m.measureText(text).width;
  }

  /** Lines, label and handles of `l` in pane media coordinates (`width`: pane width). */
  geometry(l: AlertLabelSpec, width: number): Geometry | null {
    const series = this._series;
    if (!series) return null;
    const ys: number[] = [];
    for (const p of this.levelsOf(l)) {
      const y = series.priceToCoordinate(p);
      if (y == null) return null;
      ys.push(y as number);
    }
    let tooltip: Geometry["tooltip"] = null;
    if (this.isActive(l.id) && !this._state.moving) {
      const left = this._state.side === "left";
      const dist = ys.length === 1 ? TOOLTIP_X_ONE : TOOLTIP_X_TWO;
      const px = left ? dist : width - dist;
      const py = ys[Math.min(this.activeLevel(l.id), ys.length - 1)];
      const maxW = Math.max(20, 0.9 * (width - 80));
      let text = l.text;
      let withStatus = false;
      let content = this.textWidth(l.text) + TOOLTIP_PAD * 2 + BUTTON_W;
      if (l.status) {
        const all = this.textWidth(l.text + SEP + l.status) + TOOLTIP_PAD * 2 + BUTTON_W;
        if (all <= Math.min(all, maxW)) {
          content = all;
          withStatus = true;
        }
      }
      if (!withStatus && content > maxW) {
        // Cut with an ellipsis to the room left.
        const room = maxW - TOOLTIP_PAD * 2 - BUTTON_W;
        let lo = 0;
        let hi = text.length;
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1;
          if (this.textWidth(text.slice(0, mid) + "…") < room) lo = mid;
          else hi = mid - 1;
        }
        text = text.slice(0, lo) + "…";
      }
      const w = Math.min(content, maxW);
      let x: number;
      if (this._state.lineVisible) {
        const c = Math.max(0, 0.5 * (width - w));
        x = left ? (c < px ? px : c) : c + w < px ? c : px - w;
      } else x = left ? px : px - w;
      tooltip = { x, y: py, w, text, withStatus };
    }
    return { width, ys, tooltip };
  }

  /** What `l` has under (x, y), pane media coordinates. */
  labelAt(x: number, y: number, width: number): AlertLabelHit | null {
    const s = this._state;
    let best: AlertLabelHit | null = null;
    // Labels on top: the active one first.
    const order = [...s.labels].sort((a, b) => Number(this.isActive(b.id)) - Number(this.isActive(a.id)));
    for (const l of order) {
      const g = this.geometry(l, width);
      if (!g) continue;
      if (g.tooltip) {
        const t = g.tooltip;
        if (x >= t.x && x <= t.x + t.w && Math.abs(y - t.y) <= TOOLTIP_H / 2) {
          const btn = s.side === "left" ? x <= t.x + BUTTON_W : x >= t.x + t.w - BUTTON_W;
          return { id: l.id, level: this.activeLevel(l.id), area: btn ? "button" : "tooltip" };
        }
      }
      const drawn = s.lineVisible || this.isActive(l.id);
      for (let i = 0; i < g.ys.length; i++) {
        if (Math.abs(g.ys[i] - y) > ALERT_LINE_TOLERANCE) continue;
        const [a, b] = this.lineExtent(l, g, i);
        if (drawn && x >= a && x <= b) best ??= { id: l.id, level: i, area: "line" };
      }
      // The connector of an active channel.
      if (this.isActive(l.id) && g.ys.length > 1) {
        const cx = s.side === "left" ? ALERT_CONNECTOR_X : width - ALERT_CONNECTOR_X;
        if (Math.abs(x - cx) < ALERT_LINE_TOLERANCE && y >= Math.min(...g.ys) && y <= Math.max(...g.ys)) {
          const i = Math.abs(y - g.ys[0]) <= Math.abs(y - g.ys[1]) ? 0 : 1;
          best ??= { id: l.id, level: i, area: "line" };
        }
      }
    }
    return best;
  }

  /** What the scale shows under `y` (axis media coordinates). */
  axisHitTest(y: number): AlertLabelHit | null {
    for (const l of this._state.labels) {
      const series = this._series;
      if (!series) return null;
      const levels = this.levelsOf(l);
      for (let i = 0; i < levels.length; i++) {
        const c = series.priceToCoordinate(levels[i]);
        const half = this.isActive(l.id) ? (FONT_PX + 8) / 2 : TAB_H / 2;
        if (c != null && Math.abs((c as number) - y) <= half) return { id: l.id, level: i, area: "axis" };
      }
    }
    return null;
  }

  /** Horizontal extent of line `i` of `l`. */
  private lineExtent(l: AlertLabelSpec, g: Geometry, i: number): [number, number] {
    const s = this._state;
    const left = s.side === "left";
    const w = g.width;
    if (s.lineVisible) return [0, w];
    const one = g.ys.length === 1;
    const inset = one ? 0 : 4;
    const toTooltip = one && i === this.activeLevel(l.id);
    const dist = toTooltip ? TOOLTIP_X_ONE : ALERT_CONNECTOR_X - inset;
    return left ? [0, dist] : [w - dist, w];
  }

  private alphaOf(id: string): number {
    const start = this._state.blinks[id];
    if (start == null) return 1;
    const a = blinkAlpha(performance.now() - start, this.isActive(id));
    return a == null ? 1 : a;
  }

  private drawPane(target: CanvasRenderingTarget2D): void {
    const s = this._state;
    if (!s.labels.length || !this._series) return;
    const theme = alertLabelTheme(s.dark);
    target.useMediaCoordinateSpace(({ mediaSize }) => {
      // geometry needs the media width only
      this._mediaWidth = mediaSize.width;
    });
    const width = this._mediaWidth;
    target.useBitmapCoordinateSpace(({ context: ctx, horizontalPixelRatio: hpr, verticalPixelRatio: vpr }) => {
      for (const l of s.labels) {
        const g = this.geometry(l, width);
        if (!g) continue;
        const active = this.isActive(l.id);
        ctx.save();
        ctx.globalAlpha = this.alphaOf(l.id);
        const lw = Math.max(1, Math.floor(vpr));
        ctx.lineWidth = lw;
        ctx.strokeStyle = l.color;
        if (s.lineVisible || active) {
          ctx.setLineDash([2 * lw, 2 * lw]);
          for (let i = 0; i < g.ys.length; i++) {
            const [a, b] = this.lineExtent(l, g, i);
            const y = Math.round(g.ys[i] * vpr) + (lw % 2) / 2;
            ctx.beginPath();
            ctx.moveTo(Math.round(a * hpr), y);
            ctx.lineTo(Math.round(b * hpr), y);
            ctx.stroke();
          }
          ctx.setLineDash([]);
        }
        const cx = s.side === "left" ? ALERT_CONNECTOR_X : width - ALERT_CONNECTOR_X;
        if (active && g.ys.length > 1) {
          const x = Math.round(cx * hpr) + 0.5;
          ctx.beginPath();
          ctx.moveTo(x, Math.min(...g.ys) * vpr);
          ctx.lineTo(x, Math.max(...g.ys) * vpr);
          ctx.stroke();
        }
        if (active) {
          // Handles where the lines meet the connector.
          const sel = s.selected?.id === l.id;
          for (let i = 0; i < g.ys.length; i++) {
            const px = Math.round(cx * hpr) + 0.5;
            const py = Math.round(g.ys[i] * vpr) + 0.5;
            const disc = (r: number) => {
              const p = new Path2D();
              p.arc(px, py, r, 0, 2 * Math.PI, true);
              return p;
            };
            ctx.fillStyle = theme.back;
            ctx.fill(disc(Math.round(5 * hpr)));
            const ring = disc(Math.round(4 * hpr));
            ring.addPath(disc(Math.floor((sel && i === s.selected!.level ? 2.5 : 3) * hpr)));
            ctx.fillStyle = "#1e53e5";
            ctx.fill(ring, "evenodd");
          }
        }
        if (g.tooltip) this.drawTooltip(ctx, hpr, vpr, l, g.tooltip, theme);
        ctx.restore();
      }
    });
  }
  private _mediaWidth = 0;

  private drawTooltip(
    ctx: CanvasRenderingContext2D,
    hpr: number,
    vpr: number,
    l: AlertLabelSpec,
    t: NonNullable<Geometry["tooltip"]>,
    theme: ReturnType<typeof alertLabelTheme>,
  ): void {
    const s = this._state;
    const left = s.side === "left";
    const x = Math.round(t.x * hpr) + 0.5;
    const top = Math.round((t.y - TOOLTIP_H / 2) * vpr) + 0.5;
    const w = Math.round(t.w * hpr);
    const h = Math.round(TOOLTIP_H * vpr);
    const r = Math.round(4 * hpr);
    const box = () => {
      ctx.beginPath();
      ctx.roundRect(x, top, w, h, r);
    };
    ctx.lineWidth = Math.max(1, Math.floor(vpr));
    ctx.fillStyle = theme.back;
    box();
    ctx.fill();
    // The button: a 26 px cell at the scale-side end, a line between it and the text.
    const hoverBtn = s.hovered?.id === l.id && s.hovered.area === "button";
    const bx = left ? x : x + w - Math.round(BUTTON_W * hpr);
    ctx.save();
    box();
    ctx.clip();
    ctx.fillStyle = hoverBtn ? theme.buttonBorder : theme.back;
    ctx.fillRect(bx, top, Math.round(BUTTON_W * hpr), h);
    ctx.restore();
    ctx.strokeStyle = theme.buttonBorder;
    const sx = left ? bx + Math.round(BUTTON_W * hpr) : bx;
    ctx.beginPath();
    ctx.moveTo(sx, top);
    ctx.lineTo(sx, top + h);
    ctx.stroke();
    // Icon: a cross (deletes) or a restart arrow (a stopped alert).
    const icx = (bx + Math.round(BUTTON_W * hpr) / 2) / hpr;
    const icy = t.y;
    ctx.save();
    ctx.scale(hpr, vpr);
    ctx.lineWidth = 1.2;
    ctx.lineCap = "round";
    if (l.inactive) {
      ctx.strokeStyle = theme.restartIcon;
      ctx.beginPath();
      ctx.arc(icx, icy, 4, -0.35 * Math.PI, 1.35 * Math.PI);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(icx + 1.5, icy - 6);
      ctx.lineTo(icx + 3.6, icy - 3.6);
      ctx.lineTo(icx + 0.6, icy - 2.6);
      ctx.stroke();
    } else {
      ctx.strokeStyle = l.color;
      ctx.beginPath();
      ctx.moveTo(icx - 3.5, icy - 3.5);
      ctx.lineTo(icx + 3.5, icy + 3.5);
      ctx.moveTo(icx + 3.5, icy - 3.5);
      ctx.lineTo(icx - 3.5, icy + 3.5);
      ctx.stroke();
    }
    // Text, then " • <status>" when it fits.
    ctx.font = `${FONT_PX}px ${s.fontFamily}`;
    ctx.textBaseline = "alphabetic";
    const tx = (left ? t.x + BUTTON_W : t.x) + TOOLTIP_PAD;
    const ty = t.y + 5;
    const textColor = l.inactive ? theme.inactiveText : l.color;
    ctx.fillStyle = textColor;
    ctx.fillText(t.text, tx, ty);
    if (t.withStatus && l.status) {
      const w1 = this.textWidth(t.text);
      ctx.fillText(SEP, tx + w1, ty);
      ctx.fillStyle = l.statusColor ?? theme.inactiveText;
      ctx.fillText(l.status, tx + w1 + this.textWidth(SEP), ty);
    }
    ctx.restore();
    // Border in the line colour.
    ctx.strokeStyle = l.color;
    box();
    ctx.stroke();
  }

  private drawAxis(target: CanvasRenderingTarget2D): void {
    const s = this._state;
    const series = this._series;
    if (!s.labels.length || !series) return;
    const theme = alertLabelTheme(s.dark);
    const fmt = series.priceFormatter();
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const W = mediaSize.width;
      // The tab sits at the outer edge: right edge of a right scale, left edge of a left one.
      const outerRight = s.side === "right";
      for (const l of s.labels) {
        const active = this.isActive(l.id);
        const levels = this.levelsOf(l);
        ctx.save();
        ctx.globalAlpha = this.alphaOf(l.id);
        for (const p of levels) {
          const y = series.priceToCoordinate(p);
          if (y == null) continue;
          if (!active) {
            const path = new Path2D(TAB);
            ctx.save();
            ctx.translate(outerRight ? W : 0, (y as number) - TAB_H / 2 + 1);
            if (outerRight) ctx.scale(-1, 1);
            ctx.fillStyle = l.color;
            ctx.fill(path);
            ctx.restore();
            continue;
          }
          // The price label with an alarm clock.
          const h = FONT_PX + 8;
          const top = (y as number) - h / 2;
          ctx.fillStyle = l.color;
          ctx.fillRect(0, top, W, h);
          const ix = 9;
          const iy = y as number;
          ctx.strokeStyle = theme.icon;
          ctx.fillStyle = theme.icon;
          ctx.lineWidth = 1.2;
          ctx.lineCap = "round";
          ctx.beginPath();
          ctx.arc(ix, iy + 0.5, 4, 0, 2 * Math.PI);
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(ix - 4.5, iy - 3.5);
          ctx.lineTo(ix - 2.8, iy - 5);
          ctx.moveTo(ix + 4.5, iy - 3.5);
          ctx.lineTo(ix + 2.8, iy - 5);
          ctx.moveTo(ix, iy - 1.5);
          ctx.lineTo(ix, iy + 0.7);
          ctx.lineTo(ix + 1.6, iy + 0.7);
          ctx.stroke();
          ctx.font = `${FONT_PX}px ${s.fontFamily}`;
          ctx.textBaseline = "middle";
          ctx.textAlign = "left";
          ctx.fillText(fmt.format(p), 18, iy);
        }
        ctx.restore();
      }
    });
  }
}
