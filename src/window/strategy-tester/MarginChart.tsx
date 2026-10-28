/*
 * "Margin utilization" of the Margin usage tab (the reference app module
 * 151996):
 * - area line (#3179F5, 2 px, 20 % gradient fill) of the margin used after
 *   each bar with fills and of the highest margin in between
 *   (metrics.marginLine): Percent of the equity (0 - 100 %, the default) or
 *   Regular (currency), from the Scale menu of the gear button (kept);
 *   whitespaces make the time axis proportional; dotted vertical crosshair;
 * - margin call markers along the bottom of the pane: 21 px circles (wider
 *   pills for 2+ digit counts), the trades a margin call closed clustered
 *   when closer than 15 px, the count inside (× for one, 99+); hover: a
 *   dashed line up from the marker and the crosshair pinned on the line;
 *   click: the "Forced liquidations" popover above it (one card per trade,
 *   or one summed card for more than 3);
 * - tooltip: margin usage, open trades, date.
 */
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import {
  AreaSeries,
  CrosshairMode,
  LineSeries,
  LineStyle,
  LineType,
  TrackingModeExitMode,
  createChart,
  type IChartApi,
  type IPriceLine,
  type IPrimitivePaneView,
  type ISeriesApi,
  type ISeriesPrimitive,
  type MouseEventParams,
  type PrimitiveHoveredItem,
  type SeriesAttachedParameter,
  type Time,
  type TickMarkType,
  type UTCTimestamp,
} from "lightweight-charts";
import { formatTick } from "../chart/view/helpers";
import type { BacktestReport, MarginPoint } from "../../backtester/types";
import { Icon } from "../../components/Icon";
import * as kv from "../../data/kv";
import { Popover, PopItem, PopSectionTitle } from "../screener/Popover";
import { Tooltip } from "../../components/Tooltip";
import { money, percent, tradeDate } from "./format";
import { liquidations, marginLine, type Liquidation, type MarginLinePoint } from "./metrics";
import { CHART_FONT, PALETTE as P, fillRoundRect, paneView, reportTheme, themed, withAlpha, type BitmapScope } from "./report-chart-kit";
import { ChartTip, Widget, type TipAnchor } from "./ReportWidget";

const PERCENT_KEY = "ot:strategy-tester:margin-axis";

const lineColors = () =>
  themed(
    { line: P.blue400, area: withAlpha(P.blue400, 0.2), base: P.gray450, grid: P.gray800, text: P.gray300, crosshair: P.gray700 },
    { line: P.blue400, area: withAlpha(P.blue400, 0.2), base: P.gray550, grid: P.gray100, text: P.gray900, crosshair: P.gray150 },
  );
type MarkerColors = { stroke: string; fill: string; fillActive: string; glyph: string; glyphActive: string; hoverLine: string };
const markerColors = (): MarkerColors =>
  themed(
    { stroke: P.red400, fill: P.gray900, fillActive: P.red400, glyph: P.red400, glyphActive: P.white, hoverLine: withAlpha(P.red400, 0.65) },
    { stroke: P.red600, fill: P.white, fillActive: P.red600, glyph: P.red600, glyphActive: P.white, hoverLine: withAlpha(P.red600, 0.65) },
  );

/** Marker height (and least width), px; markers sit 2 px above the pane bottom. */
const MARKER = 21;
/** Markers closer than this merge. */
const CLUSTER_GAP = MARKER - 6;
const CROSS = new Path2D("M5.53 4.47 4.468 5.53 7.939 9l-3.47 3.47 1.06 1.06L9 10.06l3.47 3.47 1.06-1.06L10.06 9l3.47-3.47-1.06-1.06L9 7.94z");

const markerLabel = (n: number) => (n <= 1 ? null : n > 99 ? "99+" : String(n));

type Cluster = { x: number; items: Liquidation[]; point: MarginLinePoint };
type MarkerItem = { x: number; width: number; label: string | null; hovered: boolean; active: boolean };
export type MarkerClick = { cluster: Cluster; rect: DOMRect };

/** The line point nearest in time (null outside the line). */
function nearestPoint(sec: number, pts: MarginLinePoint[]): MarginLinePoint | null {
  if (!pts.length || sec < pts[0].time || sec > pts[pts.length - 1].time) return null;
  let lo = 0;
  let hi = pts.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (pts[mid].time <= sec) lo = mid;
    else hi = mid - 1;
  }
  const next = pts[lo + 1];
  return next !== undefined && next.time - sec < sec - pts[lo].time ? next : pts[lo];
}

class LiquidationMarkers implements ISeriesPrimitive<Time> {
  private chart: IChartApi | null = null;
  private series: ISeriesApi<"Area"> | null = null;
  private requestUpdate: (() => void) | null = null;
  private liquidations: Liquidation[] = [];
  private points: MarginLinePoint[] = [];
  private clusters: Cluster[] = [];
  private items: MarkerItem[] = [];
  private hovered: number | null = null;
  private active: number | null = null;
  private signature = "";
  private version = 0;
  private mouse: { x: number; y: number } | null = null;
  private measure: CanvasRenderingContext2D | null = null;

  constructor(
    private colors: MarkerColors,
    private readonly onClick: (c: MarkerClick) => void,
  ) {}

  private readonly view = paneView("top", (t) => t.useBitmapCoordinateSpace((s) => this.draw(s, 0, true)));
  private readonly axisView = paneView("top", (t) => t.useBitmapCoordinateSpace((s) => this.draw(s, -(this.chart?.timeScale().width() ?? 0), false)));

  attached(p: SeriesAttachedParameter<Time>): void {
    this.chart = p.chart;
    this.series = p.series as ISeriesApi<"Area">;
    this.requestUpdate = p.requestUpdate;
    const el = p.chart.chartElement();
    el.addEventListener("mousemove", this.onMove, true);
    el.addEventListener("mouseleave", this.onLeave);
    el.addEventListener("click", this.onClickEvent);
  }

  detached(): void {
    const el = this.chart?.chartElement();
    el?.removeEventListener("mousemove", this.onMove, true);
    el?.removeEventListener("mouseleave", this.onLeave);
    el?.removeEventListener("click", this.onClickEvent);
    this.chart = this.series = this.requestUpdate = null;
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return [this.view];
  }

  priceAxisPaneViews(): readonly IPrimitivePaneView[] {
    return [this.axisView];
  }

  hitTest(x: number, y: number): PrimitiveHoveredItem | null {
    return this.indexAt(x, y) === -1 ? null : { externalId: "liquidation-markers", zOrder: "top", cursorStyle: "pointer" };
  }

  setData(liquidations: Liquidation[], points: MarginLinePoint[]): void {
    this.liquidations = liquidations;
    this.points = points;
    this.version++;
    this.requestUpdate?.();
  }

  setColors(colors: MarkerColors): void {
    this.colors = colors;
    this.requestUpdate?.();
  }

  /** The cluster whose popover is open (first trade number), drawn filled. */
  setActive(tradeNumber: number | null): void {
    this.active = tradeNumber;
    this.requestUpdate?.();
  }

  /** The line point of the hovered marker (the crosshair is pinned there). */
  hoveredPoint(): MarginLinePoint | null {
    return this.hovered === null ? null : (this.clusters[this.hovered]?.point ?? null);
  }

  updateAllViews(): void {
    const ts = this.chart?.timeScale();
    if (!ts) return;
    const range = ts.getVisibleLogicalRange();
    const sig = `${ts.width()}|${range?.from ?? ""}|${range?.to ?? ""}|${this.version}`;
    if (sig !== this.signature) {
      this.signature = sig;
      this.cluster();
      this.refreshHovered();
    }
    this.items = this.clusters.map((c, i) => {
      const label = markerLabel(c.items.length);
      return {
        x: c.x,
        width: label === null ? MARKER : Math.max(MARKER, Math.ceil(this.textWidth(label)) + 10),
        label,
        hovered: i === this.hovered,
        active: this.active !== null && c.items.some((l) => l.tradeNumber === this.active),
      };
    });
  }

  private cluster(): void {
    const ts = this.chart!.timeScale();
    const placed: { x: number; data: Liquidation; point: MarginLinePoint }[] = [];
    for (const l of this.liquidations) {
      const point = nearestPoint(l.time / 1000, this.points);
      const x = point ? ts.timeToCoordinate(point.time as Time) : null;
      if (point && x !== null) placed.push({ x, data: l, point });
    }
    const out: Cluster[] = [];
    let group: typeof placed = [];
    let lastX = 0;
    for (const p of placed) {
      const c = out[out.length - 1];
      if (!c || p.x - lastX >= CLUSTER_GAP) {
        out.push({ x: p.x, items: [p.data], point: p.point });
        group = [p];
      } else {
        group.push(p);
        c.items.push(p.data);
        c.x = (group[0].x + p.x) / 2;
        // The point of the group member nearest the merged x.
        c.point = group.reduce((a, b) => (Math.abs(b.x - c.x) < Math.abs(a.x - c.x) ? b : a)).point;
      }
      lastX = p.x;
    }
    this.clusters = out;
  }

  private textWidth(s: string): number {
    if (!this.measure) {
      this.measure = document.createElement("canvas").getContext("2d");
      if (this.measure) this.measure.font = `600 11px ${CHART_FONT}`;
    }
    return this.measure?.measureText(s).width ?? 0;
  }

  private paneHeight(): number | null {
    return this.series?.getPane().getHeight() ?? null;
  }

  private indexAt(x: number, y: number): number {
    const h = this.paneHeight();
    const top = h === null ? 0 : h - MARKER - 2;
    if (h === null || y < top || y > top + MARKER) return -1;
    return this.items.findIndex((it) => Math.abs(x - it.x) <= it.width / 2);
  }

  private refreshHovered(): boolean {
    const r = this.chart?.chartElement().getBoundingClientRect();
    const i = this.mouse && r ? this.indexAt(this.mouse.x - r.left, this.mouse.y - r.top) : -1;
    const next = i === -1 ? null : i;
    if (next === this.hovered) return false;
    this.hovered = next;
    return true;
  }

  private readonly onMove = (e: MouseEvent) => {
    this.mouse = { x: e.clientX, y: e.clientY };
    if (this.refreshHovered()) this.requestUpdate?.();
  };

  private readonly onLeave = () => {
    this.mouse = null;
    if (this.refreshHovered()) this.requestUpdate?.();
  };

  private readonly onClickEvent = (e: MouseEvent) => {
    const r = this.chart?.chartElement().getBoundingClientRect();
    const h = this.paneHeight();
    if (!r || h === null) return;
    const i = this.indexAt(e.clientX - r.left, e.clientY - r.top);
    const it = this.items[i];
    if (i === -1 || !it) return;
    this.onClick({ cluster: this.clusters[i], rect: new DOMRect(r.left + it.x - it.width / 2, r.top + h - MARKER - 2, it.width, MARKER) });
  };

  private draw(s: BitmapScope, xOffset: number, hoverLine: boolean): void {
    if (!this.items.length) return;
    const top = s.mediaSize.height - MARKER - 2;
    const hovered = this.items.find((i) => i.hovered) ?? null;
    const active = this.items.find((i) => i.active) ?? null;
    // Hovered and active markers on top.
    const order = [...this.items.filter((i) => i !== hovered && i !== active).reverse(), ...[active === hovered ? null : active, hovered].filter((i): i is MarkerItem => i !== null)];
    const box = (it: MarkerItem) => {
      const left = Math.round((it.x + xOffset - it.width / 2) * s.horizontalPixelRatio);
      const width = it.width * s.horizontalPixelRatio;
      const y = Math.round(top * s.verticalPixelRatio);
      const height = MARKER * s.verticalPixelRatio;
      return { left, y, width, height, cx: left + width / 2, cy: y + height / 2 };
    };
    const ctx = s.context;
    if (hoverLine && hovered) {
      const b = box(hovered);
      ctx.save();
      ctx.lineWidth = s.horizontalPixelRatio;
      ctx.strokeStyle = this.colors.hoverLine;
      ctx.setLineDash([4 * s.verticalPixelRatio, 6 * s.verticalPixelRatio]);
      ctx.beginPath();
      ctx.moveTo(b.cx, 0);
      ctx.lineTo(b.cx, b.y);
      ctx.stroke();
      ctx.restore();
    }
    for (const it of order) {
      const b = box(it);
      if (b.left + b.width < 0 || b.left > s.bitmapSize.width) continue;
      const border = 1.5 * s.horizontalPixelRatio;
      const r = b.height / 2 - border / 2;
      fillRoundRect(ctx, b.left + border / 2, b.y + border / 2, b.width - border, b.height - border, it.active ? this.colors.fillActive : this.colors.fill, [r, r, r, r]);
      ctx.save();
      ctx.lineWidth = border;
      ctx.strokeStyle = this.colors.stroke;
      ctx.beginPath();
      ctx.roundRect(b.left + border / 2, b.y + border / 2, b.width - border, b.height - border, r);
      ctx.stroke();
      ctx.restore();
      const glyph = it.active ? this.colors.glyphActive : this.colors.glyph;
      ctx.save();
      ctx.fillStyle = glyph;
      if (it.label === null) {
        ctx.translate(b.cx, b.cy);
        ctx.scale(s.horizontalPixelRatio, s.verticalPixelRatio);
        ctx.translate(-9, -9);
        ctx.fill(CROSS);
      } else {
        ctx.font = `600 ${11 * s.verticalPixelRatio}px ${CHART_FONT}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(it.label, b.cx, b.cy);
      }
      ctx.restore();
    }
  }
}

/** Whitespace slots between the points: a step of the day (or wider, at most 2000 slots) between each two. */
function whitespace(pts: { time: number }[], step = 86_400, max = 2000): { time: Time }[] {
  if (!pts.length) return [];
  const last = pts[pts.length - 1].time;
  const span = last - pts[0].time;
  const grid = step * (span > 0 ? Math.max(1, Math.ceil(span / max / step)) : 1);
  const out: { time: Time }[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const t = pts[i].time;
    out.push({ time: t as Time });
    const gap = pts[i + 1].time - t;
    const n = Math.max(1, Math.round(gap / grid));
    for (let k = 1; k < n; k++) out.push({ time: Math.round(t + (gap * k) / n) as Time });
  }
  out.push({ time: last as Time });
  // Whole seconds may meet a point's +1 ms time: keep the times strictly ascending.
  return out.filter((p, i) => i === 0 || (p.time as number) > (out[i - 1].time as number));
}

type Card = { first: number; last: number | null; quantity: number; price: number; amount: number };

function cards(items: Liquidation[]): Card[] {
  if (items.length <= 3) return items.map((l) => ({ first: l.tradeNumber, last: null, quantity: l.quantity, price: l.price, amount: l.amount }));
  const quantity = items.reduce((s, l) => s + l.quantity, 0);
  const amount = items.reduce((s, l) => s + l.amount, 0);
  const numbers = items.map((l) => l.tradeNumber);
  return [{ first: Math.min(...numbers), last: Math.max(...numbers), quantity, price: quantity === 0 ? 0 : amount / quantity, amount }];
}

const qty = new Intl.NumberFormat("en-US", { maximumFractionDigits: 8 });

/** "Forced liquidations" popover, 7 px above the marker, centred on it. */
function LiquidationsPopover(props: { click: MarkerClick; currency: string; onClose: () => void }) {
  let el!: HTMLDivElement;
  const [pos, setPos] = createSignal({ x: 0, y: 0 });
  const place = () => {
    const r = props.click.rect;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const x = Math.min(Math.max(0, r.left + r.width / 2 - w / 2), document.documentElement.clientWidth - w);
    setPos({ x, y: Math.max(0, r.top - 7 - h) });
  };
  onMount(() => {
    place();
    const onDown = (e: PointerEvent) => {
      // A press on the marker is left to the marker (it toggles the popover).
      const r = props.click.rect;
      const onMarker = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      if (!el.contains(e.target as Node) && !onMarker) props.onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    onCleanup(() => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    });
  });
  createEffect(on(() => props.click, place, { defer: true }));
  const items = () => props.click.cluster.items;
  const label = () => markerLabel(items().length);
  return (
    <Portal>
      <div ref={el} class="scr-popover st-liq-popover" style={{ left: `${pos().x}px`, top: `${pos().y}px` }} role="dialog" data-qa-id="margin-usage-liquidations-popover">
        <div class="st-liq">
          <div class="st-liq-header">
            <span class="st-liq-badge" classList={{ "has-count": label() !== null }}>
              {label() ?? <Icon name="scr-pill-remove" size={18} />}
            </span>
            <span class="st-liq-title">{items().length === 1 ? "Forced liquidation" : "Forced liquidations"}</span>
          </div>
          <For each={cards(items())}>
            {(c, i) => (
              <div class="st-liq-card" classList={{ "has-divider": i() > 0 }}>
                <div class="st-liq-caption">{c.last === null ? `Trade #${c.first}` : `Trades #${c.first}–${c.last}`}</div>
                <div class="st-liq-rows">
                  <span class="st-liq-cell">Quantity</span>
                  <span class="st-liq-cell is-value">{qty.format(c.quantity)}</span>
                  <span class="st-liq-cell">Average price</span>
                  <span class="st-liq-cell is-value">
                    {money(c.price)}
                    <span class="st-liq-unit">{props.currency}</span>
                  </span>
                  <span class="st-liq-cell">Amount</span>
                  <span class="st-liq-cell is-value">
                    {money(c.amount)}
                    <span class="st-liq-unit">{props.currency}</span>
                  </span>
                </div>
              </div>
            )}
          </For>
        </div>
      </div>
    </Portal>
  );
}

export function MarginChart(props: { report: BacktestReport; intraday: boolean; timeZone: string }) {
  let host!: HTMLDivElement;
  let gear!: HTMLButtonElement;
  let chart: IChartApi | null = null;
  let line: ISeriesApi<"Area"> | null = null;
  let blank: ISeriesApi<"Line"> | null = null;
  let base: IPriceLine | null = null;
  let markers: LiquidationMarkers | null = null;
  const [asPercent, setAsPercent] = createSignal(kv.getItem(PERCENT_KEY) !== "absolute");
  const [menu, setMenu] = createSignal(false);
  const [tip, setTip] = createSignal<{ anchor: TipAnchor; point: MarginPoint } | null>(null);
  const [popover, setPopover] = createSignal<MarkerClick | null>(null);
  const usage = () => props.report.marginUsage ?? [];
  const points = createMemo(() => marginLine(usage(), asPercent()));
  const liqs = createMemo(() => liquidations(props.report));
  const hasData = () => usage().length > 0;

  const chooseScale = (percentScale: boolean) => {
    kv.setItem(PERCENT_KEY, percentScale ? "percent" : "absolute");
    setAsPercent(percentScale);
    setMenu(false);
  };

  let pinning = false;
  const pinnedOrTip = (p: MouseEventParams<Time>) => {
    if (!chart || !line || pinning) return;
    const pinned = markers?.hoveredPoint() ?? null;
    if (pinned) {
      chart.applyOptions({ crosshair: { vertLine: { visible: false } } });
      setTip(null);
      pinning = true;
      chart.setCrosshairPosition(pinned.value, pinned.time as Time, line);
      pinning = false;
      return;
    }
    chart.applyOptions({ crosshair: { vertLine: { visible: true } } });
    const d = p.point && p.time !== undefined ? (p.seriesData.get(line) as { customValues?: MarginPoint } | undefined) : undefined;
    const point = d?.customValues;
    if (!p.point || !point) return setTip(null);
    const r = host.getBoundingClientRect();
    setTip({ anchor: { x: r.left + p.point.x, y: r.top + p.point.y, el: host }, point });
  };

  onMount(() => {
    const c = lineColors();
    chart = createChart(host, {
      width: host.clientWidth,
      height: host.clientHeight,
      trackingMode: { exitMode: TrackingModeExitMode.OnTouchEnd },
      handleScale: false,
      handleScroll: false,
      grid: { horzLines: { visible: true, color: c.grid }, vertLines: { visible: false } },
      timeScale: {
        timeVisible: props.intraday,
        secondsVisible: false,
        borderVisible: false,
        fixLeftEdge: true,
        fixRightEdge: true,
        // Tick labels in the exchange zone, as on the chart.
        tickMarkFormatter: (t: Time, tt: TickMarkType) => formatTick(t as UTCTimestamp, tt, props.timeZone, {}, props.intraday),
      },
      layout: { background: { color: "transparent" }, textColor: c.text, fontSize: 12, fontFamily: CHART_FONT, attributionLogo: false },
      leftPriceScale: { visible: false },
      rightPriceScale: { visible: true, borderVisible: false, scaleMargins: { top: 0.15, bottom: 0 }, alignLabels: true, entireTextOnly: true },
      crosshair: {
        mode: CrosshairMode.Magnet,
        doNotSnapToHiddenSeriesIndices: true,
        horzLine: { visible: false, labelVisible: false },
        vertLine: { labelVisible: false, style: LineStyle.Solid, color: c.crosshair },
      },
      localization: { locale: "en-US" },
    });
    blank = chart.addSeries(LineSeries, {
      visible: false,
      lineVisible: false,
      lastValueVisible: false,
      priceLineVisible: false,
      crosshairMarkerVisible: false,
      pointMarkersVisible: false,
      autoscaleInfoProvider: () => null,
    });
    line = chart.addSeries(AreaSeries, {
      topColor: c.area,
      bottomColor: "transparent",
      relativeGradient: true,
      lineColor: c.line,
      lineStyle: LineStyle.Solid,
      lineType: LineType.Simple,
      lineWidth: 2,
      lastValueVisible: false,
      priceLineVisible: false,
    });
    base = line.createPriceLine({ price: 0, color: c.base, lineWidth: 1, lineStyle: LineStyle.Solid, axisLabelVisible: false });
    markers = new LiquidationMarkers(
      markerColors(),
      (click) => setPopover((open) => (open && open.cluster.items[0]?.tradeNumber === click.cluster.items[0]?.tradeNumber ? null : click)),
    );
    line.attachPrimitive(markers);
    chart.subscribeCrosshairMove(pinnedOrTip);
    const ro = new ResizeObserver(() => {
      chart?.applyOptions({ width: host.clientWidth, height: host.clientHeight });
      chart?.timeScale().fitContent();
      setPopover(null);
    });
    ro.observe(host);
    const scroller = host.closest(".st-metrics");
    const closePopover = () => setPopover(null);
    scroller?.addEventListener("scroll", closePopover);
    onCleanup(() => {
      ro.disconnect();
      scroller?.removeEventListener("scroll", closePopover);
      setTip(null);
      chart?.unsubscribeCrosshairMove(pinnedOrTip);
      chart?.remove();
      chart = null;
    });
  });

  createEffect(() => {
    const pts = points();
    const pct = asPercent();
    if (!chart || !line || !blank) return;
    chart.applyOptions({ localization: { locale: "en-US", priceFormatter: (v: number) => (pct ? percent(v) : money(v)) } });
    line.applyOptions({ autoscaleInfoProvider: pct ? () => ({ priceRange: { minValue: 0, maxValue: 1 } }) : (base: () => null) => base() });
    line.setData(pts.map((p) => ({ time: p.time as Time, value: p.value, customValues: p.point as unknown as Record<string, unknown> })));
    blank.setData(whitespace(pts));
    markers?.setData(liqs(), pts);
    chart.timeScale().fitContent();
    setPopover(null);
  });

  createEffect(() => markers?.setActive(popover()?.cluster.items[0]?.tradeNumber ?? null));

  createEffect(
    on(reportTheme, () => {
      const c = lineColors();
      chart?.applyOptions({ layout: { textColor: c.text }, crosshair: { vertLine: { color: c.crosshair } }, grid: { horzLines: { color: c.grid } } });
      line?.applyOptions({ topColor: c.area, lineColor: c.line });
      base?.applyOptions({ color: c.base });
      markers?.setColors(markerColors());
    }, { defer: true }),
  );

  const gearButton = (
    <Tooltip text="Scale" side="top">
      <button ref={gear} type="button" class="st-page-btn" classList={{ "is-active": menu() }} data-name="margin-usage-chart-scale-settings" onClick={() => setMenu(!menu())}>
        <Icon name="st-equity-scale-settings" size={18} />
      </button>
    </Tooltip>
  );

  return (
    <Widget title="Margin utilization" hasData={hasData()} actions={gearButton}>
      <div class="st-margin-area">
        <div ref={host} class="st-margin-chart" />
      </div>
      <Show when={tip()}>
        {(t) => (
          <ChartTip
            anchor={t().anchor}
            offset={8}
            rows={[
              { title: "Margin usage", value: asPercent() ? percent(t().point.percent) : money(t().point.value) },
              { title: "Trades", value: String(t().point.tradesOpen) },
            ]}
            foot={tradeDate(t().point.time, props.intraday, props.timeZone)}
          />
        )}
      </Show>
      <Show when={popover()}>{(c) => <LiquidationsPopover click={c()} currency={props.report.currency} onClose={() => setPopover(null)} />}</Show>
      <Show when={menu()}>
        <Popover anchor={gear} onClose={() => setMenu(false)} class="st-equity-menu" width={168} offset={{ x: 28 - 168, y: 0 }}>
          <PopSectionTitle title="Scale" />
          <PopItem title="Percent" selected={asPercent()} onClick={() => chooseScale(true)} />
          <PopItem title="Regular" selected={!asPercent()} onClick={() => chooseScale(false)} />
        </Popover>
      </Show>
    </Widget>
  );
}
