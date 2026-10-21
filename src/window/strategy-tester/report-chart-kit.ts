/*
 * Shared plumbing of the report tab charts (Metrics view sub-tabs), after the
 * reference app's report chart helpers:
 * - its palette colours and the app theme as a signal (each chart keeps a
 *   dark and a light colour set, as the reference app does);
 * - PrettyPriceScale (module 212389): 5 round levels over all the data
 *   (integer steps for counts), grid lines in the pane and labels drawn
 *   right-aligned in the price scale, whose own labels are hidden;
 * - HoverBar (851051): the hovered bar's slot shaded;
 * - ChartPager (638380): the bars spread over the width when they fit at the
 *   minimum spacing, else pages of whole bars between two 28 px arrows
 *   (10 px gaps), moved by the arrows (300 ms ease in-out), a drag or a
 *   horizontal wheel;
 * - the axis number format (86.00 K).
 */
import { createSignal } from "solid-js";
import {
  ColorType,
  CrosshairMode,
  MismatchDirection,
  TrackingModeExitMode,
  type AutoscaleInfo,
  type ChartOptions,
  type DeepPartial,
  type IChartApi,
  type IPrimitivePaneRenderer,
  type IPrimitivePaneView,
  type ISeriesApi,
  type ISeriesPrimitive,
  type LogicalRange,
  type MouseEventParams,
  type PrimitivePaneViewZOrder,
  type SeriesAttachedParameter,
  type SeriesType,
  type Time,
} from "lightweight-charts";
import { uiTheme, type StdTheme } from "../header/chart-settings";
import { MINUS, NNBSP, money } from "./format";

export const CHART_FONT = `-apple-system, BlinkMacSystemFont, "Trebuchet MS", Roboto, Ubuntu, sans-serif`;

/** The reference app's palette (getHexColorByName). */
export const PALETTE = {
  green50: "#DAF2EE",
  green200: "#70CCBD",
  green400: "#22AB94",
  green600: "#06806B",
  green800: "#004D40",
  red50: "#FFEBEC",
  red200: "#FAA1A4",
  red400: "#F7525F",
  red600: "#CC2F3C",
  red800: "#991F29",
  gray100: "#F2F2F2",
  gray150: "#EBEBEB",
  gray200: "#DBDBDB",
  gray250: "#C9C9C9",
  gray300: "#B8B8B8",
  gray450: "#8C8C8C",
  gray550: "#707070",
  gray650: "#575757",
  gray700: "#4A4A4A",
  gray800: "#2E2E2E",
  gray900: "#0F0F0F",
  blue400: "#3179F5",
  white: "#FFFFFF",
} as const;

/** `#RRGGBB` at opacity `a`. */
export function withAlpha(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

// The app theme (the <html> theme class) as a signal: the canvases re-colour on a switch.
const [theme, setTheme] = createSignal<StdTheme>(uiTheme());
if (typeof document !== "undefined") {
  new MutationObserver(() => setTheme(uiTheme())).observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
}
export const reportTheme = theme;
/** The dark or the light set of a chart's colours, for the current theme. */
export const themed = <T>(dark: T, light: T): T => (theme() === "light" ? light : dark);

const nf2 = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const UNITS = ["", "K", "M", "B", "T"];

/** Axis numbers of the report charts: 2 decimals, K / M / B / T from a thousand ("86.00 K", "−43.00 K", "0.00"). */
export function volume2(v: number): string {
  const sign = v < 0 && Math.abs(v) >= 0.005 ? MINUS : "";
  let a = Math.abs(v);
  let u = 0;
  while (u < UNITS.length - 1 && Math.round(a * 100) / 100 >= 1000) {
    a /= 1000;
    u++;
  }
  return sign + nf2.format(a) + (u ? NNBSP + UNITS[u] : "");
}

/** Money value of the chart tooltips: 2 decimals, "+" when `signed` and above 0; exactly 0 reads "0". */
export const tipMoney = (v: number, signed = false) => (v === 0 ? "0" : money(v, signed));

const utcFormats = new Map<string, Intl.DateTimeFormat>();
/** UNIX ms as a UTC date ("Jul 5", "Jul 5, 2020", "Jul 2020", "2020"): bucket dates are UTC days. */
export function utcDate(ms: number, parts: "monthDay" | "date" | "monthYear" | "year"): string {
  const options: Intl.DateTimeFormatOptions =
    parts === "monthDay" ? { month: "short", day: "numeric" } : parts === "date" ? { month: "short", day: "numeric", year: "numeric" } : parts === "monthYear" ? { month: "short", year: "numeric" } : { year: "numeric" };
  let f = utcFormats.get(parts);
  if (!f) utcFormats.set(parts, (f = new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" })));
  return f.format(new Date(ms));
}

/** Quarter of a UTC date: "Q3 '20". */
export function quarterLabel(ms: number): string {
  const d = new Date(ms);
  return `Q${Math.floor(d.getUTCMonth() / 3) + 1} '${String(d.getUTCFullYear() % 100).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Canvas targets (the fancy-canvas scopes lightweight-charts hands over).

export type BitmapScope = {
  context: CanvasRenderingContext2D;
  horizontalPixelRatio: number;
  verticalPixelRatio: number;
  bitmapSize: { width: number; height: number };
  mediaSize: { width: number; height: number };
};
export type MediaScope = { context: CanvasRenderingContext2D; mediaSize: { width: number; height: number } };
export type DrawTarget = {
  useBitmapCoordinateSpace: (f: (s: BitmapScope) => void) => void;
  useMediaCoordinateSpace: (f: (s: MediaScope) => void) => void;
};

/** A pane view drawing with `draw` at `zOrder`. */
export function paneView(zOrder: PrimitivePaneViewZOrder, draw: (t: DrawTarget) => void): IPrimitivePaneView {
  const renderer: IPrimitivePaneRenderer = { draw: (t) => draw(t as unknown as DrawTarget) };
  return { zOrder: () => zOrder, renderer: () => renderer };
}

/** Pixel rows of a box from y1 to y2 (the reference app positionsBox): rounded ends, both rows included. */
export function positionsBox(y1: number, y2: number, ratio: number): { position: number; length: number } {
  const a = Math.round(ratio * y1);
  const b = Math.round(ratio * y2);
  return { position: Math.min(a, b), length: Math.abs(b - a) + 1 };
}

/** Filled rounded rectangle (radii: top-left, top-right, bottom-right, bottom-left). */
export function fillRoundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string, radii: number[]): void {
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, radii);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
}

/** Options all the report bar charts share: sized to the host, transparent, no grid, no crosshair lines, no
 *  scroll / zoom (the pager turns scrolling on), right scale only. */
export function chartBase(host: HTMLElement, textColor: string, fontSize = 12): DeepPartial<ChartOptions> {
  return {
    width: host.clientWidth,
    height: host.clientHeight,
    trackingMode: { exitMode: TrackingModeExitMode.OnTouchEnd },
    handleScale: false,
    handleScroll: false,
    grid: { horzLines: { visible: false }, vertLines: { visible: false } },
    layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor, fontSize, fontFamily: CHART_FONT, attributionLogo: false },
    leftPriceScale: { visible: false },
    crosshair: { mode: CrosshairMode.Normal, horzLine: { visible: false, labelVisible: false }, vertLine: { visible: false, labelVisible: false } },
  };
}

// ---------------------------------------------------------------------------
// Pretty price scale.

const fixComputation = (v: number) => Math.round(1e10 * v) / 1e10;

/** A round number at or above v: 1 / 5 x 10^k steps, finer with `k`. */
function roundUp(v: number, k = 0): number {
  const base = k % 2 === 0 ? 1 : 5;
  const digits = Math.floor((k + 1) / 2) + 1;
  const magnitude = (Math.log(Math.abs(v)) * Math.LOG10E + 1) | 0;
  const step = Math.pow(10 * base, magnitude - digits);
  return Math.ceil(v / step) * step;
}

/** Step for `n` steps up to v: the first round step that wastes less than 15 % of a step. */
function niceStep(v: number, n: number): number {
  if (!Number.isFinite(v) || n === 0) return v;
  const raw = v / n;
  let s = roundUp(raw);
  for (let k = 1; k < 4 && !(s * n - v < 0.15 * n * s); k++) s = roundUp(raw, k);
  return s;
}

type Bounds = { lowerBound: number; upperBound: number; step: number; linesCount?: number };

/** Lowest / highest level and the step of `count` levels holding min..max (with 0 when the data crosses it). */
export function prettyBounds(min: number, max: number, count: number, integer = false): Bounds {
  if (integer) {
    const n = count - 1;
    const up = Math.max(0, max);
    const down = Math.max(0, -min);
    const total = up + down;
    let step = Math.max(1, roundUp(total / n));
    while (step < total && Math.ceil(up / step) + Math.ceil(down / step) > n) step += 1;
    const above = Math.ceil(up / step);
    const below = Math.ceil(down / step);
    return { lowerBound: fixComputation(-step * below), upperBound: fixComputation(step * above), step, linesCount: above + below + 1 };
  }
  if (max > 0 && min < 0) {
    const down = Math.abs(min);
    const total = max + down;
    const big = Math.max(max, down);
    const small = Math.min(max, down);
    const bigSteps = Math.ceil((big / total) * (count - 2));
    const smallSteps = count - 1 - bigSteps;
    const a = niceStep(big, bigSteps);
    const b = niceStep(small, smallSteps);
    const m = Math.min(b, a);
    const step = b === a || (m * bigSteps > big && m * smallSteps > small) ? m : Math.max(b, a);
    return max > down
      ? { lowerBound: fixComputation(-step * smallSteps), upperBound: fixComputation(step * bigSteps), step }
      : { lowerBound: fixComputation(-step * bigSteps), upperBound: fixComputation(step * smallSteps), step };
  }
  const negative = max <= 0 && min <= 0;
  const step = niceStep(negative ? -min : max, count - 1);
  return negative ? { lowerBound: fixComputation(-step * (count - 1)), upperBound: 0, step } : { lowerBound: 0, upperBound: fixComputation(step * (count - 1)), step };
}

type ScaleMark = { y: number; text: string };

export class PrettyPriceScale<D> implements ISeriesPrimitive<Time> {
  private series: ISeriesApi<SeriesType> | null = null;
  private requestUpdate: (() => void) | null = null;
  private bounds: Bounds | null = null;
  private marks: ScaleMark[] = [];
  private fontSize = 12;
  private fontFamily = CHART_FONT;

  constructor(
    private colors: { grid: string; text: string },
    private readonly getValues: (d: D) => number[],
    private readonly format: (v: number) => string,
    private integer = false,
  ) {}

  private readonly gridView = paneView("bottom", (t) =>
    t.useBitmapCoordinateSpace(({ context: ctx, bitmapSize, verticalPixelRatio: vr }) => {
      if (!this.marks.length) return;
      ctx.save();
      ctx.strokeStyle = this.colors.grid;
      ctx.lineWidth = vr;
      for (const m of this.marks) {
        const y = Math.round(m.y * vr);
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(bitmapSize.width, y);
        ctx.stroke();
      }
      ctx.restore();
    }),
  );

  private readonly labelsView = paneView("top", (t) =>
    t.useBitmapCoordinateSpace(({ context: ctx, bitmapSize, horizontalPixelRatio: hr, verticalPixelRatio: vr }) => {
      if (!this.marks.length) return;
      const x = bitmapSize.width - hr;
      const half = (this.fontSize * vr) / 2;
      ctx.save();
      ctx.font = `${this.fontSize * vr}px ${this.fontFamily}`;
      ctx.fillStyle = this.colors.text;
      ctx.textAlign = "right";
      for (const m of this.marks) {
        const y = Math.round(m.y * vr);
        // The edge labels stay inside the scale.
        ctx.textBaseline = y - half < 0 ? "top" : y + half > bitmapSize.height ? "bottom" : "middle";
        ctx.fillText(m.text, x, y);
      }
      ctx.restore();
    }),
  );

  private readonly autoscale = (base: () => AutoscaleInfo | null): AutoscaleInfo | null => {
    const r = base();
    return this.bounds ? { priceRange: { minValue: this.bounds.lowerBound, maxValue: this.bounds.upperBound }, margins: r?.margins } : r;
  };

  private readonly onData = () => {
    this.bounds = this.computeBounds();
    this.requestUpdate?.();
  };

  attached(p: SeriesAttachedParameter<Time>): void {
    this.series = p.series;
    this.requestUpdate = p.requestUpdate;
    const layout = p.chart.options().layout;
    this.fontSize = layout.fontSize;
    this.fontFamily = layout.fontFamily;
    p.series.applyOptions({ autoscaleInfoProvider: this.autoscale });
    p.series.subscribeDataChanged(this.onData);
    p.series.priceScale().applyOptions({ textColor: "transparent", ticksVisible: false });
    this.onData();
  }

  detached(): void {
    this.series?.unsubscribeDataChanged(this.onData);
    this.series = this.requestUpdate = null;
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return [this.gridView];
  }

  priceAxisPaneViews(): readonly IPrimitivePaneView[] {
    return [this.labelsView];
  }

  updateAllViews(): void {
    const s = this.series;
    const b = this.bounds;
    this.marks = [];
    if (!s || !b) return;
    const n = b.step === 0 ? 1 : (b.linesCount ?? 5);
    for (let i = 0; i < n; i++) {
      const v = b.lowerBound + b.step * i;
      const y = s.priceToCoordinate(v);
      if (y !== null) this.marks.push({ y, text: this.format(v) });
    }
  }

  setColors(colors: { grid: string; text: string }): void {
    this.colors = colors;
    this.requestUpdate?.();
  }

  setInteger(integer: boolean): void {
    if (this.integer === integer) return;
    this.integer = integer;
    this.onData();
  }

  private computeBounds(): Bounds | null {
    const data = (this.series?.data() ?? []) as unknown as D[];
    let min = Infinity;
    let max = -Infinity;
    for (const d of data) {
      for (const v of this.getValues(d) ?? []) {
        if (!Number.isFinite(v)) continue;
        min = Math.min(min, v);
        max = Math.max(max, v);
      }
    }
    return Number.isFinite(min) && Number.isFinite(max) ? prettyBounds(min, max, 5, this.integer) : null;
  }
}

// ---------------------------------------------------------------------------
// Hovered bar.

/** The bar under the mouse: the time's data, or with `lone`, the only bar of the series anywhere in the pane. */
export function hoveredBar<D>(p: MouseEventParams<Time>, series: ISeriesApi<SeriesType>, lone: boolean): { time: Time; bar: D | undefined } | null {
  if (p.point === undefined || p.logical === undefined) return null;
  if (p.time !== undefined) return { time: p.time, bar: p.seriesData.get(series) as D | undefined };
  if (!lone) return null;
  const first = series.dataByIndex(0, MismatchDirection.NearestRight);
  const last = series.dataByIndex(Number.MAX_SAFE_INTEGER, MismatchDirection.NearestLeft);
  return first && last && first.time === last.time ? { time: first.time, bar: first as unknown as D } : null;
}

type HoverOptions = {
  color: string;
  /** Shade the whole pane height (else down to the zero line). */
  fullPane?: boolean;
  /** Shade empty slots too. */
  whitespace?: boolean;
  /** A single bar shades the whole pane. */
  lone?: boolean;
};

export class HoverBar implements ISeriesPrimitive<Time> {
  private chart: IChartApi | null = null;
  private series: ISeriesApi<SeriesType> | null = null;
  private requestUpdate: (() => void) | null = null;
  private hovered: { time: Time; bar: unknown } | null = null;
  private box: { x: number; width: number; height: number } | null = null;

  constructor(private options: HoverOptions) {}

  private readonly view = paneView("bottom", (t) =>
    t.useBitmapCoordinateSpace(({ context: ctx, horizontalPixelRatio: hr, verticalPixelRatio: vr }) => {
      const b = this.box;
      if (!b) return;
      ctx.save();
      ctx.fillStyle = this.options.color;
      ctx.fillRect(b.x * hr, 0, b.width * hr, b.height * vr);
      ctx.restore();
    }),
  );

  private readonly onMove = (p: MouseEventParams<Time>) => {
    const h = this.series ? hoveredBar(p, this.series, !!this.options.lone) : null;
    this.hovered = h && (h.bar !== undefined || this.options.whitespace) ? h : null;
    this.requestUpdate?.();
  };

  attached(p: SeriesAttachedParameter<Time>): void {
    this.chart = p.chart;
    this.series = p.series;
    this.requestUpdate = p.requestUpdate;
    p.chart.subscribeCrosshairMove(this.onMove);
  }

  detached(): void {
    this.chart?.unsubscribeCrosshairMove(this.onMove);
    this.chart = this.series = this.requestUpdate = null;
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return [this.view];
  }

  updateAllViews(): void {
    this.box = null;
    const c = this.chart;
    const s = this.series;
    if (!c || !s || !this.hovered) return;
    const x = c.timeScale().timeToCoordinate(this.hovered.time);
    const height = this.options.fullPane ? s.getPane().getHeight() : s.priceToCoordinate(0);
    if (x === null || height === null) return;
    const lone = !!this.options.lone && s.data().length === 1;
    const width = lone ? c.paneSize().width : c.timeScale().options().barSpacing;
    this.box = { x: lone ? 0 : x - width / 2, width, height };
  }

  setColor(color: string): void {
    this.options = { ...this.options, color };
    this.requestUpdate?.();
  }
}

// ---------------------------------------------------------------------------
// Pager.

export const ARROW_WIDTH = 28;
export const ARROW_GAP = 10;

export type PagerParams = {
  minBarSpacing: number;
  maxBarSpacing?: number;
  /** Below a container width, a smaller minimum spacing (the narrowest matching layout wins). */
  narrowLayouts?: { containerWidth: number; minBarSpacing: number }[];
};
export type PagerControls = {
  showArrows: (v: boolean) => void;
  canPageLeft: (v: boolean) => void;
  canPageRight: (v: boolean) => void;
  /** Index of the narrow layout in use, -1 for none. */
  breakpoint?: (i: number) => void;
};

const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const SCROLL = { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false };

export class ChartPager {
  private items = 0;
  private perPage = 0;
  private enabled = false;
  private settle: number | null = null;
  private frame: number | null = null;
  private target: LogicalRange | null = null;
  private readonly staticEdges: { fixLeftEdge: boolean; fixRightEdge: boolean };
  private readonly ro: ResizeObserver;

  constructor(
    private readonly chart: IChartApi,
    private readonly container: HTMLElement,
    private readonly params: PagerParams,
    private readonly controls: PagerControls,
  ) {
    const ts = chart.timeScale().options();
    this.staticEdges = { fixLeftEdge: ts.fixLeftEdge, fixRightEdge: ts.fixRightEdge };
    chart.timeScale().subscribeVisibleLogicalRangeChange(this.onRange);
    this.ro = new ResizeObserver(this.layout);
    this.ro.observe(container);
  }

  setItemCount(n: number): void {
    this.items = n;
    if (this.settle !== null) cancelAnimationFrame(this.settle);
    this.layout();
    this.layout();
    this.settle = requestAnimationFrame(() => {
      this.settle = null;
      this.layout();
    });
  }

  pageLeft(): void {
    this.page(-1);
  }

  pageRight(): void {
    this.page(1);
  }

  destroy(): void {
    if (this.settle !== null) cancelAnimationFrame(this.settle);
    this.stop();
    this.setScroll(false);
    this.ro.disconnect();
    this.chart.timeScale().unsubscribeVisibleLogicalRangeChange(this.onRange);
  }

  private page(dir: number): void {
    const range = this.chart.timeScale().getVisibleLogicalRange();
    if (this.perPage === 0 || !range) return;
    const from = this.target?.from ?? Math.round(range.from);
    const span = this.perPage - 1;
    const last = Math.max(0, this.items - 1 - span);
    const next = Math.min(last, Math.max(0, from + dir * this.perPage));
    if (next !== from) this.animate(range, { from: next, to: next + span } as LogicalRange);
  }

  private animate(from: LogicalRange, to: LogicalRange): void {
    this.stop();
    this.target = to;
    const t0 = performance.now();
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / 300);
      const e = easeInOutCubic(k);
      this.chart.timeScale().setVisibleLogicalRange({ from: from.from + (to.from - from.from) * e, to: from.to + (to.to - from.to) * e });
      if (k < 1) this.frame = requestAnimationFrame(step);
      else this.frame = this.target = null;
    };
    this.frame = requestAnimationFrame(step);
  }

  private stop(): void {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = this.target = null;
  }

  private readonly onRange = (r: LogicalRange | null) => this.flags(r);

  private flags(r: LogicalRange | null): void {
    if (!r || this.items === 0) {
      this.controls.canPageLeft(false);
      this.controls.canPageRight(false);
      return;
    }
    this.controls.canPageLeft(Math.round(r.from) > 0);
    this.controls.canPageRight(Math.round(r.to) < this.items - 1);
  }

  private readonly layout = () => {
    this.stop();
    const narrow = this.params.narrowLayouts ?? [];
    const width = this.container.clientWidth;
    let bp = -1;
    narrow.forEach((l, i) => {
      if (width < l.containerWidth && (bp === -1 || l.containerWidth < narrow[bp].containerWidth)) bp = i;
    });
    this.controls.breakpoint?.(bp);
    const minSpacing = bp === -1 ? this.params.minBarSpacing : narrow[bp].minBarSpacing;
    const scale = this.chart.priceScale("right").width();
    const total = width - 1;
    let showArrows = false;
    let spacing = minSpacing;
    let perPage = 0;
    let chartWidth = total;
    if (this.items > 0) {
      if (this.items * minSpacing <= total - scale) {
        const fit = (total - scale) / this.items;
        spacing = this.params.maxBarSpacing === undefined || fit <= this.params.maxBarSpacing ? fit : this.params.maxBarSpacing;
        perPage = this.items;
      } else {
        showArrows = true;
        chartWidth = total - 2 * (ARROW_WIDTH + ARROW_GAP);
        perPage = Math.max(1, Math.floor((chartWidth - scale) / minSpacing));
        spacing = (chartWidth - scale) / perPage;
      }
    }
    this.perPage = perPage;
    this.controls.showArrows(showArrows);
    this.setScroll(showArrows);
    const height = this.chart.chartElement().clientHeight;
    if (perPage === 0) {
      this.flags(null);
      this.chart.resize(chartWidth, height, true);
      return;
    }
    const ts = this.chart.timeScale();
    const range = ts.getVisibleLogicalRange();
    if (this.items === 1) ts.setVisibleLogicalRange({ from: -0.5, to: 0.5 });
    else if (range) {
      const span = perPage - 1;
      const to = showArrows ? Math.min(this.items - 1, Math.max(span, Math.round(range.to))) : span;
      ts.setVisibleLogicalRange({ from: Math.max(0, to - perPage + 1), to });
    }
    ts.applyOptions({ barSpacing: spacing, minBarSpacing: minSpacing });
    this.chart.resize(chartWidth, height, true);
    this.flags(ts.getVisibleLogicalRange());
  };

  /** Paged: drag and horizontal wheel scroll the bars (the edges fixed). */
  private setScroll(on: boolean): void {
    if (this.enabled === on) return;
    this.enabled = on;
    this.chart.applyOptions({ handleScroll: on ? SCROLL : false });
    this.chart.timeScale().applyOptions({ fixLeftEdge: on || this.staticEdges.fixLeftEdge, fixRightEdge: on || this.staticEdges.fixRightEdge });
    const el = this.chart.chartElement();
    if (on) {
      el.addEventListener("wheel", this.onWheel, { passive: false });
      el.addEventListener("pointerdown", this.onPointerDown);
    } else {
      el.removeEventListener("wheel", this.onWheel);
      el.removeEventListener("pointerdown", this.onPointerDown);
    }
  }

  private readonly onPointerDown = () => this.stop();

  private readonly onWheel = (e: WheelEvent) => {
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
    e.preventDefault();
    this.stop();
    const ts = this.chart.timeScale();
    ts.scrollToPosition(ts.scrollPosition() + e.deltaX / ts.options().barSpacing, false);
  };
}
