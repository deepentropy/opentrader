/*
 * Performance chart of the Metrics view (TradingView 3.4.1; design doc §3.3
 * and §14.9 - §14.15). A lightweight-charts instance: transparent over
 * #0f0f0f, text #b8b8b8 12px, dotted horizontal grid, vertical crosshair
 * #4a4a4a without labels, no scroll / zoom, right scale min width 80.
 *
 * Series (z order): zero line; Trades excursions bars (excursion-series.ts);
 * Cumulative PnL baseline at 0 (#089981 / #F23645, 5 % fills) with a circle
 * per trade colored by sign (hidden under 10 px bar spacing); Buy and hold
 * line #5B9CF6 (hidden by default); the Run-ups and drawdowns strip
 * (equity-strip.ts). Header: Scale menu (Percent / Regular, Whitespaces),
 * snapshot menu, Expand / Collapse chart. Legend with eye toggles and a
 * collapse button. Hover: trade card (click = show the trade exit on the
 * price chart) or, on the strip, the period card.
 */
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import {
  BaselineSeries,
  CrosshairMode,
  LineSeries,
  LineStyle,
  createChart,
  createSeriesMarkers,
  type AutoscaleInfo,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type MouseEventParams,
  type SeriesMarker,
  type Time,
} from "lightweight-charts";
import type { BacktestReport } from "../../backtester/types";
import { Icon } from "../../components/Icon";
import { Tooltip } from "../../components/Tooltip";
import { Popover, PopItem, PopSectionTitle, PopDivider } from "../screener/Popover";
import { strategyTester } from "../../data/strategy-tester-store";
import { commands } from "../../bindings";
import { EXCURSION_COLORS, ExcursionSeries, type ExcursionData } from "./excursion-series";
import { EquityStrip, type StripHover } from "./equity-strip";
import { equityPoints, reportPeriods, whitespaceTimes, type EquityPoint } from "./equity-data";
import { DASH, MINUS, money, percent as pct } from "./format";

const FONT = `-apple-system, BlinkMacSystemFont, "Trebuchet MS", Roboto, Ubuntu, sans-serif`;
const UP = "#089981";
const DOWN = "#F23645";
const BUY_HOLD = "#5B9CF6";
/** Autoscale margins (px) and the room kept around the zero line (TradingView `I()` / `E`). */
const MARGINS = { above: 10, below: 10 };
const MAX_ZERO_PAD = 65;

/**
 * Price range that keeps 0 inside with `zeroPad` px between the zero line and
 * the pane edge on the empty side (TradingView equity autoscale, padding
 * ratio at most 0.1 of the scale).
 */
function zeroPaddedRange(min: number, max: number, height: number, zeroPad: number): { minValue: number; maxValue: number } {
  const minSpan = 1e-6;
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  if (lo === hi) {
    const e = Math.max(minSpan, Math.abs(lo) > 0 ? 1e-9 * Math.abs(lo) : 1e-9);
    return { minValue: Math.min(lo - e, 0), maxValue: Math.max(lo + e, 0) };
  }
  let c = height > 0 ? zeroPad / height : 0;
  if (!Number.isFinite(c) || c < 0) c = 0;
  c = Math.min(c, 0.1);
  const up = Math.max(hi, 0);
  const down = Math.max(-lo, 0);
  const total = up + down;
  let span: number;
  if (total === 0) span = Math.max(minSpan, 0) / Math.max(1 - 2 * c, 1e-9);
  else {
    const small = Math.min(up, down) / total;
    const big = Math.max(up, down) / total;
    if (c <= small) span = total;
    else if (c <= big) span = (up <= down ? down : up) / Math.max(1 - c, 1e-9);
    else span = total / Math.max(1 - 2 * c, 1e-9);
  }
  if (span < minSpan) span = minSpan;
  const m = c * span;
  let top = Math.max(hi, m);
  let bottom = Math.min(lo, -m);
  if (!(top > bottom)) {
    const mid = (top + bottom) / 2;
    const h = Math.max(minSpan / 2, 1e-9);
    bottom = mid - h;
    top = mid + h;
  }
  if (bottom > 0) bottom = Math.min(0, bottom);
  if (top < 0) top = Math.max(0, top);
  return { minValue: bottom, maxValue: top };
}

const weekdayDate = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "America/New_York" });
const weekdayDateTime = new Intl.DateTimeFormat("en-US", {
  weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "America/New_York",
});
const dayDate = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/New_York" });

type Props = {
  report: BacktestReport;
  intraday: boolean;
  /** Chart interval in seconds (Whitespaces grid step). */
  intervalSec: number;
  onShowOnChart: (timeSec: number) => void;
};

type TradeCard = { point: EquityPoint; x: number; y: number };

export function EquityChart(props: Props) {
  let wrap!: HTMLDivElement;
  let host!: HTMLDivElement;
  let scaleBtn!: HTMLButtonElement;
  let snapBtn!: HTMLButtonElement;
  let chart: IChartApi | null = null;
  let zero: ISeriesApi<"Baseline"> | null = null;
  let bars: ISeriesApi<"Custom", Time, ExcursionData> | null = null;
  let pnl: ISeriesApi<"Baseline"> | null = null;
  let bh: ISeriesApi<"Line"> | null = null;
  let markers: ISeriesMarkersPluginApi<Time> | null = null;
  let strip: EquityStrip | null = null;

  const settings = strategyTester.equity;
  const vis = () => settings().visible;
  const [menu, setMenu] = createSignal<"scale" | "snapshot" | null>(null);
  const [card, setCard] = createSignal<TradeCard | null>(null);
  const [period, setPeriod] = createSignal<StripHover>(null);
  const [size, setSize] = createSignal({ w: 0, h: 0 });

  const points = createMemo(() => equityPoints(props.report, settings().percent));
  const periods = createMemo(() => reportPeriods(props.report, equityPoints(props.report, false)));
  const cur = () => props.report.currency;
  const fmt = (v: number) => (settings().percent ? pct(v) : money(v));

  const priceFormatter = (v: number) =>
    settings().percent ? `${v < 0 ? MINUS : ""}${Math.abs(v * 100).toFixed(2)}%` : money(v);

  const autoscale = (base: () => AutoscaleInfo | null): AutoscaleInfo | null => {
    const r = base();
    if (!r || !r.priceRange || !chart) return r;
    const h = chart.paneSize().height;
    const range = zeroPaddedRange(r.priceRange.minValue, r.priceRange.maxValue, h, Math.min(h / 2, MAX_ZERO_PAD));
    return { priceRange: range, margins: MARGINS };
  };

  onMount(() => {
    chart = createChart(host, {
      autoSize: true,
      // Solid #0F0F0F as in TradingView: the strip hover blend needs an opaque canvas.
      layout: { background: { color: "#0F0F0F" }, textColor: "#B8B8B8", fontSize: 12, fontFamily: FONT, attributionLogo: false },
      localization: { locale: "en-US", priceFormatter },
      grid: { vertLines: { visible: false }, horzLines: { color: "rgba(219, 219, 219, 0.2)", style: LineStyle.SparseDotted } },
      crosshair: {
        vertLine: { color: "#4A4A4A", width: 1, style: LineStyle.Solid, labelVisible: false },
        horzLine: { visible: false, labelVisible: false },
      },
      rightPriceScale: { borderVisible: false, minimumWidth: 80, entireTextOnly: true },
      timeScale: { borderVisible: false, fixLeftEdge: true, fixRightEdge: true, lockVisibleTimeRangeOnResize: true, minBarSpacing: 4, barSpacing: 21 },
      handleScroll: false,
      handleScale: false,
    });
    zero = chart.addSeries(BaselineSeries, {
      baseValue: { type: "price", price: 0 },
      topLineColor: "#2E2E2E",
      bottomLineColor: "#2E2E2E",
      topFillColor1: "transparent",
      topFillColor2: "transparent",
      bottomFillColor1: "transparent",
      bottomFillColor2: "transparent",
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
      autoscaleInfoProvider: autoscale,
    });
    zero.createPriceLine({ price: 0, color: "#2E2E2E", lineWidth: 1, lineStyle: LineStyle.Solid, axisLabelVisible: false });
    bars = chart.addCustomSeries(new ExcursionSeries(), { priceLineVisible: false, lastValueVisible: false }) as ISeriesApi<"Custom", Time, ExcursionData>;
    pnl = chart.addSeries(BaselineSeries, {
      baseValue: { type: "price", price: 0 },
      lineWidth: 2,
      topLineColor: UP,
      bottomLineColor: DOWN,
      topFillColor1: "rgba(34, 171, 148, 0.05)",
      topFillColor2: "rgba(34, 171, 148, 0.05)",
      bottomFillColor1: "rgba(247, 124, 128, 0.05)",
      bottomFillColor2: "rgba(247, 124, 128, 0.05)",
      crosshairMarkerBorderWidth: 3,
      crosshairMarkerBorderColor: "#000000",
      priceLineVisible: false,
      autoscaleInfoProvider: autoscale,
    });
    bh = chart.addSeries(LineSeries, { color: BUY_HOLD, lineWidth: 1, visible: false, priceLineVisible: false, lastValueVisible: false, autoscaleInfoProvider: autoscale });
    markers = createSeriesMarkers(pnl, [], { zOrder: "top" });
    strip = new EquityStrip((h) => {
      setPeriod(h);
      chart?.applyOptions({ crosshair: { mode: h ? CrosshairMode.Hidden : CrosshairMode.Normal } });
      if (h) setCard(null);
    });
    // The strip rides on an empty series added last (TradingView's
    // runupDrawdownSegment series): its hover dimming paints over the lines.
    chart.addSeries(BaselineSeries, { lineWidth: 3, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }).attachPrimitive(strip);

    chart.subscribeCrosshairMove(onCrosshair);
    chart.subscribeClick(onClick);
    const ro = new ResizeObserver(() => setSize({ w: host.clientWidth, h: host.clientHeight }));
    ro.observe(host);
    onCleanup(() => {
      ro.disconnect();
      chart?.unsubscribeCrosshairMove(onCrosshair);
      chart?.unsubscribeClick(onClick);
      chart?.remove();
      chart = null;
    });
  });

  /** Equity point nearest in time to a chart time (left or right neighbour). */
  function nearest(time: number): EquityPoint | null {
    const pts = points();
    if (!pts.length) return null;
    let lo = 0;
    let hi = pts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pts[mid].time < time) lo = mid + 1;
      else hi = mid;
    }
    const right = pts[lo];
    const left = pts[lo - 1];
    if (!left) return right;
    return time - left.time <= right.time - time ? left : right;
  }

  function onCrosshair(p: MouseEventParams<Time>) {
    if (!p.point || p.time === undefined || period()) return setCard(null);
    const pt = nearest(p.time as number);
    setCard(pt ? { point: pt, x: p.point.x, y: p.point.y } : null);
  }

  function onClick(p: MouseEventParams<Time>) {
    if (p.time === undefined) return;
    const pt = nearest(p.time as number);
    const t = pt ? props.report.trades[pt.tradeIndex] : undefined;
    if (t) props.onShowOnChart(Math.floor(t.exit.time / 1000));
  }

  // Data + layout. One point per trade; Whitespaces adds empty time slots.
  createEffect(() => {
    const pts = points();
    const ws = settings().whitespaces ? whitespaceTimes(pts, props.intervalSec) : [];
    const { w } = size();
    if (!chart || !zero || !bars || !pnl || !bh || !markers || !strip) return;
    const blank = ws.map((t) => ({ time: t as Time }));
    const merge = <T extends { time: Time }>(items: T[]) =>
      blank.length ? [...items, ...blank].sort((a, b) => (a.time as number) - (b.time as number)) : items;
    pnl.setData(merge(pts.map((p) => ({ time: p.time as Time, value: p.value }))));
    bh.setData(merge(pts.map((p) => ({ time: p.time as Time, value: p.buyHold }))));
    bars.setData(merge(pts.map((p) => ({ time: p.time as Time, values: p.excursions }))) as ExcursionData[]);
    zero.setData(pts.length ? [{ time: pts[0].time as Time, value: 0 }, { time: pts[pts.length - 1].time as Time, value: 0 }] : []);
    strip.setPeriods(periods());
    chart.applyOptions({ localization: { locale: "en-US", priceFormatter } });
    // Percent values are fractions of the capital: a finer price step.
    const priceFormat = { type: "custom" as const, formatter: priceFormatter, minMove: settings().percent ? 1e-6 : 0.01 };
    for (const sr of [zero, pnl, bh]) sr.applyOptions({ priceFormat });
    // Zoom: all points fit (min bar spacing = pane width / slots); 10 points
    // or less keep a fixed 60 px spacing.
    const slots = pts.length + ws.length;
    const ts = chart.timeScale();
    if (pts.length && pts.length <= 10 && !ws.length) {
      ts.applyOptions({ minBarSpacing: 60, barSpacing: 60, fixRightEdge: false });
      ts.fitContent();
    } else {
      ts.applyOptions({ minBarSpacing: 0, fixRightEdge: true });
      ts.fitContent();
      // TradingView sets the minimum spacing on the next frame, after the fit.
      requestAnimationFrame(() => {
        if (!chart) return;
        chart.timeScale().fitContent();
        const pane = chart.paneSize().width || w;
        if (slots && pane) chart.timeScale().applyOptions({ minBarSpacing: pane / slots });
      });
    }
    // Circles per trade, colored by sign; none under 10 px bar spacing
    // (all slots fit the pane width, or 60 px with 10 points or less).
    const paneWidth = chart.paneSize().width || w;
    const spacing = pts.length <= 10 && !ws.length ? 60 : slots ? paneWidth / slots : 0;
    const marks: SeriesMarker<Time>[] =
      spacing < 10 || !vis().pnl
        ? []
        : pts.map((p) => ({ time: p.time as Time, position: "inBar", shape: "circle", size: 0.1, color: p.value >= 0 ? UP : DOWN }));
    markers.setMarkers(marks);
  });

  createEffect(() => {
    const v = vis();
    pnl?.applyOptions({ visible: v.pnl });
    bh?.applyOptions({ visible: v.buyHold });
    bars?.applyOptions({ visible: v.excursions });
    strip?.setVisible(v.periods);
  });

  const legend = [
    { key: "pnl", label: "Cumulative PnL" },
    { key: "buyHold", label: "Buy and hold" },
    { key: "excursions", label: "Trades excursions" },
    { key: "periods", label: "Run-ups and drawdowns" },
  ] as const;
  const toggle = (k: keyof ReturnType<typeof vis>) => strategyTester.patchEquity({ visible: { ...vis(), [k]: !vis()[k] } });

  // Trade card: 16 px right of the mouse (left of it when it would cover the
  // price scale), vertically centred on the mouse. Widths are read from the
  // rendered card (node signals), heights through the CSS transform.
  const [cardEl, setCardEl] = createSignal<HTMLDivElement>();
  const cardStyle = () => {
    const c = card();
    if (!c || !chart) return {};
    const w = cardEl()?.offsetWidth ?? 0;
    const flip = c.x + 16 + w > chart.paneSize().width;
    return { left: `${flip ? c.x - 16 : c.x + 16}px`, top: `${c.y}px`, transform: `translate(${flip ? "-100%" : "0"}, -50%)` };
  };
  // Period card: 16 px right of the period end (left of its start when it
  // does not fit), bottom edge 12 px above the strip centre.
  const [periodEl, setPeriodEl] = createSignal<HTMLDivElement>();
  const periodStyle = () => {
    const h = period();
    if (!h) return {};
    const r = host.getBoundingClientRect();
    const w = periodEl()?.offsetWidth ?? 0;
    const flip = h.xEnd - r.left + 16 + w > r.width;
    const left = flip ? h.xStart - r.left - 16 : h.xEnd - r.left + 16;
    return { left: `${left}px`, top: `${h.y - r.top - 12}px`, transform: `translate(${flip ? "-100%" : "0"}, -100%)` };
  };

  const tradeCard = createMemo(() => {
    const c = card();
    if (!c) return null;
    const t = props.report.trades[c.point.tradeIndex];
    if (!t) return null;
    const rows: { label: string; color: string; value: string }[] = [];
    if (vis().pnl) rows.push({ label: "Cumulative PnL", color: c.point.value >= 0 ? UP : DOWN, value: fmt(c.point.value) });
    if (vis().excursions && !t.open) {
      rows.push({ label: "Favorable excursion", color: EXCURSION_COLORS[0], value: fmt(c.point.excursions[0]) });
      rows.push({ label: "Adverse excursion", color: EXCURSION_COLORS[2], value: fmt(c.point.excursions[2]) });
    }
    if (vis().buyHold) rows.push({ label: "Buy and hold", color: BUY_HOLD, value: fmt(c.point.buyHold) });
    const date = t.open ? "Open" : (props.intraday ? weekdayDateTime : weekdayDate).format(new Date(t.exit.time)).replace(/(\d{4}) at /, "$1, ");
    return { title: `Trade ${c.point.tradeIndex + 1} ${t.direction}`, rows, date };
  });

  // Snapshot: the chart canvas, local only (Download / Copy / Open in new tab).
  const snapshot = (action: "download" | "copy" | "open") => {
    setMenu(null);
    if (!chart) return;
    const canvas = chart.takeScreenshot();
    if (action === "open") {
      const b64 = canvas.toDataURL("image/png").split(",")[1] ?? "";
      void commands.openSnapshot(b64);
      return;
    }
    canvas.toBlob((blob) => {
      if (!blob) return;
      if (action === "copy" && typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
        void navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        return;
      }
      const d = new Date();
      const p2 = (n: number) => String(n).padStart(2, "0");
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `Equity chart_${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}_${p2(d.getHours())}-${p2(d.getMinutes())}-${p2(d.getSeconds())}.png`;
      a.click();
      URL.revokeObjectURL(a.href);
    }, "image/png");
  };

  const expanded = strategyTester.equityExpanded;

  return (
    <div ref={wrap} class="st-equity-block" classList={{ "is-expanded": expanded() }}>
      <div class="st-block-header">
        <span class="st-block-title">Performance</span>
        <div class="st-equity-actions">
          <Tooltip text="Scale" side="top">
            <button ref={scaleBtn} type="button" class="st-light-btn" classList={{ "is-active": menu() === "scale" }} data-name="equity-chart-scale-settings" onClick={() => setMenu(menu() === "scale" ? null : "scale")}>
              <Icon name="st-equity-scale-settings" size={18} />
            </button>
          </Tooltip>
          <Tooltip text="Take a snapshot" side="top">
            <button ref={snapBtn} type="button" class="st-light-btn" classList={{ "is-active": menu() === "snapshot" }} aria-label="Take a snapshot" onClick={() => setMenu(menu() === "snapshot" ? null : "snapshot")}>
              <Icon name="st-equity-snapshot" size={18} />
            </button>
          </Tooltip>
          <Tooltip text={expanded() ? "Collapse chart" : "Expand chart"} side="top">
            <button type="button" class="st-light-btn" aria-label={expanded() ? "Collapse chart" : "Expand chart"} onClick={() => strategyTester.setEquityExpanded(!expanded())}>
              <Icon name={expanded() ? "st-equity-collapse" : "st-equity-expand"} size={18} />
            </button>
          </Tooltip>
        </div>
      </div>

      <div class="st-equity">
        <div class="st-equity-chart" ref={host} />
        <div class="st-equity-legend">
          <Show
            when={!settings().legendCollapsed}
            fallback={
              <button type="button" class="st-equity-legend-toggler is-collapsed" title="Show metrics legend" onClick={() => strategyTester.patchEquity({ legendCollapsed: false })}>
                <Icon name="st-equity-legend-toggler" size={15} />
                <span>{legend.length}</span>
              </button>
            }
          >
            <For each={legend}>
              {(l) => (
                <div class="st-equity-legend-line" classList={{ "is-hidden": !vis()[l.key] }}>
                  <span class="st-equity-legend-title">{l.label}</span>
                  <button
                    type="button"
                    class="st-equity-legend-eye"
                    title={vis()[l.key] ? "Hide" : "Show"}
                    data-qa-id={`series-visibility-toggle ${vis()[l.key] ? "visible" : "hidden"}`}
                    onClick={() => toggle(l.key)}
                  >
                    <Icon name={vis()[l.key] ? "st-legend-eye-show" : "st-legend-hide"} size={18} />
                  </button>
                </div>
              )}
            </For>
            <button type="button" class="st-equity-legend-toggler" title="Hide metrics legend" onClick={() => strategyTester.patchEquity({ legendCollapsed: true })}>
              <Icon name="st-equity-legend-toggler" size={15} />
            </button>
          </Show>
        </div>

        <Show when={tradeCard()}>
          {(tc) => (
            <div ref={setCardEl} class="st-equity-card" style={cardStyle()}>
              <div class="st-equity-card-title">{tc().title}</div>
              <Show when={tc().rows.length}>
                <div class="st-equity-card-rows">
                  <For each={tc().rows}>
                    {(row) => (
                      <>
                        <span class="st-equity-card-label">
                          <span class="st-equity-card-dot" style={{ background: row.color }} />
                          {row.label}
                        </span>
                        <span class="st-equity-card-value">
                          {row.value}
                          <Show when={!settings().percent}>
                            <span class="st-equity-card-currency">{cur()}</span>
                          </Show>
                        </span>
                      </>
                    )}
                  </For>
                </div>
              </Show>
              <div class="st-equity-card-foot">{tc().date}</div>
              <div class="st-equity-card-foot">Click to show on chart</div>
            </div>
          )}
        </Show>

        <Show when={period()}>
          {(h) => (
            <div ref={setPeriodEl} class="st-equity-card st-period-card" style={periodStyle()}>
              <div class="st-period-line">
                <span class="st-period-type">{h().period.type === "drawdown" ? "Drawdown" : "Run-up"}</span>
                <span class="st-equity-card-value">
                  {money(h().period.change)}
                  <span class="st-equity-card-currency">{cur()}</span>
                </span>
              </div>
              <div class="st-period-percent">{pct(h().period.relativeChange)}</div>
              <div class="st-equity-card-foot">
                {dayDate.format(new Date(h().period.startTime * 1000))} {DASH} {dayDate.format(new Date(h().period.endTime * 1000))}
              </div>
            </div>
          )}
        </Show>
      </div>

      <Show when={menu() === "scale"}>
        <Popover anchor={scaleBtn} onClose={() => setMenu(null)} class="st-equity-menu" width={168} offset={{ x: 28 - 168, y: 0 }}>
          <PopSectionTitle title="Scale" />
          <PopItem title="Percent" selected={settings().percent} onClick={() => { strategyTester.patchEquity({ percent: true }); setMenu(null); }} />
          <PopItem title="Regular" selected={!settings().percent} onClick={() => { strategyTester.patchEquity({ percent: false }); setMenu(null); }} />
          <PopDivider />
          <div class="st-switch-row" onClick={() => strategyTester.patchEquity({ whitespaces: !settings().whitespaces })}>
            <span>Whitespaces</span>
            <span class="ind3-switch" classList={{ "is-on": settings().whitespaces }} role="switch" aria-checked={settings().whitespaces}>
              <span class="ind3-switch-thumb" />
            </span>
          </div>
        </Popover>
      </Show>
      <Show when={menu() === "snapshot"}>
        <Popover anchor={snapBtn} onClose={() => setMenu(null)} class="st-equity-menu" offset={{ x: 0, y: 0 }}>
          <PopSectionTitle title="Equity chart snapshot" />
          <PopItem icon="st-snapshot-download-image" title="Download image" onClick={() => snapshot("download")} />
          <PopItem icon="st-snapshot-copy-image" title="Copy image" onClick={() => snapshot("copy")} />
          <PopItem icon="st-snapshot-open-in-new-tab" title="Open in new tab" onClick={() => snapshot("open")} />
        </Popover>
      </Show>
    </div>
  );
}
