/*
 * "Run-ups and drawdowns" strip of the Performance chart (the reference app module
 * 240420 classes D / L / N / P; design doc §14.11):
 * - one 4 px line per period at the bottom of the pane (rows paneHeight - 6
 *   .. paneHeight - 3), butt caps, run-up #089981 / drawdown #F23645 at 50 %,
 *   100 % when hovered; a period that starts where the previous one ends
 *   starts 1 px later;
 * - hover zone: the bottom 4 * devicePixelRatio px of the pane and below;
 * - hovered period: both sides dimmed (#0f0f0f at 70 % + a "saturation"
 *   #7F7F7F pass, bottom 8 px left clear), the series on top veiled with
 *   #2E2E2E ("source-atop"), 1 px #636363 lines at the start and the end.
 */
import type {
  IChartApi,
  ISeriesApi,
  ISeriesPrimitive,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  PrimitivePaneViewZOrder,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from "lightweight-charts";
import type { EquityPeriod } from "./equity-data";

const WIDTH = 4;
const RUNUP = "8, 153, 129";
const DRAWDOWN = "242, 54, 69";
const BACKGROUND = "rgba(15, 15, 15, 0.7)";
const DESATURATE = "#7F7F7F";
const VEIL = "#2E2E2E";
const BOUNDARY = "#636363";

export type StripHover = { period: EquityPeriod; xStart: number; xEnd: number; y: number } | null;

type Bitmap = {
  context: CanvasRenderingContext2D;
  horizontalPixelRatio: number;
  verticalPixelRatio: number;
  bitmapSize: { width: number; height: number };
};
type Target = { useBitmapCoordinateSpace: (f: (s: Bitmap) => void) => void };

const clamp = (v: number, a: number, b: number) => Math.min(Math.max(v, a), b);
function sides(start: number, end: number, width: number) {
  const a = clamp(start, 0, width);
  const b = clamp(end, 0, width);
  return { left: { x: 0, width: a }, right: { x: b, width: width - b } };
}

export class EquityStrip implements ISeriesPrimitive<Time> {
  private chart: IChartApi | null = null;
  private series: ISeriesApi<SeriesType> | null = null;
  private requestUpdate: (() => void) | null = null;
  private periods: EquityPeriod[] = [];
  private hovered = -1;
  private visible = true;
  private lastMouse: { x: number; y: number } | null = null;

  constructor(private readonly onHover: (h: StripHover) => void) {}

  private readonly stripView: IPrimitivePaneView = {
    zOrder: (): PrimitivePaneViewZOrder => "normal",
    renderer: (): IPrimitivePaneRenderer => ({ draw: (t) => this.drawStrip(t as unknown as Target) }),
  };
  private readonly veilView: IPrimitivePaneView = {
    zOrder: (): PrimitivePaneViewZOrder => "top",
    renderer: (): IPrimitivePaneRenderer => ({ draw: (t) => this.drawVeil(t as unknown as Target) }),
  };

  attached(p: SeriesAttachedParameter<Time>): void {
    this.chart = p.chart;
    this.series = p.series;
    this.requestUpdate = p.requestUpdate;
    const el = p.chart.chartElement();
    el.addEventListener("mousemove", this.onMove);
    el.addEventListener("mouseleave", this.onLeave);
    p.chart.timeScale().subscribeVisibleLogicalRangeChange(this.onRange);
  }

  detached(): void {
    const el = this.chart?.chartElement();
    el?.removeEventListener("mousemove", this.onMove);
    el?.removeEventListener("mouseleave", this.onLeave);
    this.chart?.timeScale().unsubscribeVisibleLogicalRangeChange(this.onRange);
    this.chart = null;
    this.series = null;
    this.requestUpdate = null;
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return [this.stripView, this.veilView];
  }

  setPeriods(periods: EquityPeriod[]): void {
    this.periods = periods;
    this.hovered = -1;
    this.requestUpdate?.();
    this.recheck();
  }

  setVisible(v: boolean): void {
    this.visible = v;
    if (!v) this.clearHover();
    this.requestUpdate?.();
  }

  private readonly onRange = () => this.recheck();
  private readonly onLeave = () => {
    this.lastMouse = null;
    this.clearHover();
  };
  private readonly onMove = (e: MouseEvent) => {
    this.lastMouse = { x: e.clientX, y: e.clientY };
    this.recheck();
  };

  private clearHover(): void {
    if (this.hovered === -1) return;
    this.hovered = -1;
    this.onHover(null);
    this.requestUpdate?.();
  }

  private recheck(): void {
    const m = this.lastMouse;
    const chart = this.chart;
    if (!m || !chart || !this.visible) return this.clearHover();
    const rect = chart.chartElement().getBoundingClientRect();
    const ts = chart.timeScale();
    const tsHeight = ts.height();
    const zone = WIDTH * (window.devicePixelRatio || 1);
    if (m.y - rect.y < rect.height - tsHeight - zone) return this.clearHover();
    const t = ts.coordinateToTime(m.x - rect.x);
    const time = t == null ? null : (t as number);
    const idx = time == null ? -1 : this.periods.findIndex((p) => p.startTime <= time && p.endTime >= time);
    if (idx === -1) return this.clearHover();
    const p = this.periods[idx];
    const a = ts.timeToCoordinate(p.startTime as Time);
    const b = ts.timeToCoordinate(p.endTime as Time);
    if (a === null || b === null) return this.clearHover();
    this.hovered = idx;
    this.onHover({
      period: p,
      xStart: (a < 0 ? 0 : a) + rect.left,
      xEnd: (b > rect.width ? rect.width : b) + rect.left,
      y: rect.height - tsHeight - Math.floor(zone / 2) + rect.top,
    });
    this.requestUpdate?.();
  }

  private coords(p: EquityPeriod) {
    const ts = this.chart!.timeScale();
    return { a: ts.timeToCoordinate(p.startTime as Time), b: ts.timeToCoordinate(p.endTime as Time), width: ts.width() };
  }

  private drawStrip(target: Target): void {
    if (!this.visible || !this.chart || !this.series || !this.periods.length) return;
    const paneHeight = this.series.getPane().getHeight();
    target.useBitmapCoordinateSpace((s) => {
      const { context: ctx, horizontalPixelRatio: hr, verticalPixelRatio: vr } = s;
      const y = paneHeight - WIDTH;
      let hover: { a: number; b: number; width: number } | null = null;
      this.periods.forEach((p, i) => {
        const { a, b, width } = this.coords(p);
        if (a === null || b === null || a > width || b < 0) return;
        const prev = this.periods[i - 1] ?? p;
        const start = prev.endTime === p.startTime && prev !== p ? a + 1 : a;
        const rgb = p.type === "runup" ? RUNUP : DRAWDOWN;
        ctx.lineWidth = WIDTH * vr;
        ctx.lineCap = "butt";
        ctx.strokeStyle = `rgba(${rgb}, ${i === this.hovered ? 1 : 0.5})`;
        ctx.beginPath();
        ctx.moveTo(start * hr, y * vr);
        ctx.lineTo(b * hr, y * vr);
        ctx.stroke();
        if (i === this.hovered) hover = { a, b, width };
      });
      if (!hover) return;
      const h = hover as { a: number; b: number; width: number };
      const { left, right } = sides(h.a, h.b, h.width);
      for (const r of [left, right]) {
        if (r.width <= 0) continue;
        const x = Math.round(r.x * hr);
        const w = Math.round(r.width * hr);
        const hh = Math.round(s.bitmapSize.height - 2 * WIDTH * vr);
        ctx.save();
        ctx.fillStyle = BACKGROUND;
        ctx.fillRect(x, 0, w, hh);
        ctx.globalCompositeOperation = "saturation";
        ctx.fillStyle = DESATURATE;
        ctx.fillRect(x, 0, w, hh);
        ctx.restore();
      }
      ctx.save();
      ctx.lineWidth = hr;
      ctx.strokeStyle = BOUNDARY;
      for (const x of [h.a, h.b]) {
        ctx.beginPath();
        ctx.moveTo(Math.round(x * hr), 0);
        ctx.lineTo(Math.round(x * hr), s.bitmapSize.height);
        ctx.stroke();
      }
      ctx.restore();
    });
  }

  private drawVeil(target: Target): void {
    if (!this.visible || this.hovered === -1 || !this.chart) return;
    const p = this.periods[this.hovered];
    if (!p) return;
    const { a, b, width } = this.coords(p);
    if (a === null || b === null) return;
    const { left, right } = sides(a, b, width);
    target.useBitmapCoordinateSpace((s) => {
      for (const r of [left, right]) {
        if (r.width <= 0) continue;
        s.context.save();
        s.context.globalCompositeOperation = "source-atop";
        s.context.fillStyle = VEIL;
        s.context.fillRect(Math.round(r.x * s.horizontalPixelRatio), 0, Math.round(r.width * s.horizontalPixelRatio), s.bitmapSize.height);
        s.context.restore();
      }
    });
  }
}
