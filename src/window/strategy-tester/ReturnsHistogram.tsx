/*
 * "Returns distribution" of the Distribution tab (the reference app module
 * 754610), left of the Trades distribution donut: closed trades counted by
 * return bins (metrics.returnBins; loss bins red, profit bins green, 60 % of
 * the slot), a dotted grid with the counts on the right, dashed vertical
 * lines at the average loss and the average profit (outliers left out),
 * and the bins' round percent bounds on the time axis (the largest round
 * step whose labels fit, 16 px apart at least). Chart area 168 px.
 */
import { Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import {
  LineStyle,
  TrackingModeExitMode,
  createChart,
  type IChartApi,
  type IPriceLine,
  type IPrimitivePaneView,
  type ISeriesApi,
  type ISeriesPrimitive,
  type MouseEventParams,
  type SeriesAttachedParameter,
  type Time,
} from "lightweight-charts";
import type { BacktestReport } from "../../backtester/types";
import { Icon } from "../../components/Icon";
import { DASH, percent } from "./format";
import { averageReturns, returnBins, type ReturnBin } from "./metrics";
import { CHART_FONT, HoverBar, PALETTE as P, paneView, reportTheme, themed, withAlpha } from "./report-chart-kit";
import { CountBarsSeries, type CountBarsData } from "./report-series";
import { ChartTip, Legend, Widget, type TipAnchor } from "./ReportWidget";

const colors = () =>
  themed(
    { profit: P.green600, averageProfit: P.green400, loss: P.red600, averageLoss: P.red400, text: P.gray200, grid: P.gray800, zero: P.gray450, hovered: withAlpha(P.gray800, 0.5) },
    { profit: P.green400, averageProfit: P.green600, loss: P.red400, averageLoss: P.red600, text: P.gray900, grid: P.gray100, zero: P.gray550, hovered: withAlpha(P.gray100, 0.5) },
  );

/** Slot x of a return: linear between the first and the last bin middles (the bins are evenly spaced). */
function xOf(chart: IChartApi, bins: ReturnBin[], value: number | null): number | null {
  if (value === null || !bins.length) return null;
  const lo = bins[0].rangeMiddle;
  const hi = bins[bins.length - 1].rangeMiddle;
  const k = hi - lo === 0 ? 0 : (value - lo) / (hi - lo);
  const a = chart.timeScale().timeToCoordinate(0 as Time);
  const b = chart.timeScale().timeToCoordinate((bins.length - 1) as Time);
  return a !== null && b !== null ? Math.round(a + k * (b - a)) : null;
}

/** Round steps of the percent labels (fractions). */
const STEPS = [1e-4, 2e-4, 5e-4, 0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100];
const pct = (v: number) => `${Number((v * 100).toFixed(8))}%`;
/** Bound label width estimate: whole percents, 2 decimals under 1 %. */
const boundText = (v: number) => {
  const t = (Math.round(1e4 * v) / 1e4) * 100;
  return Math.abs(t) >= 1 ? `${Math.round(t)}%` : `${t.toFixed(2)}%`;
};

/** Average lines over the bars and the percent labels of the time axis. */
class ReturnsOverlay implements ISeriesPrimitive<Time> {
  private chart: IChartApi | null = null;
  private series: ISeriesApi<"Custom", Time, CountBarsData> | null = null;
  private requestUpdate: (() => void) | null = null;
  private bins: ReturnBin[] = [];
  private averages: { profit: number | null; loss: number | null } = { profit: null, loss: null };
  private lines: { profit: number | null; loss: number | null; height: number } | null = null;
  private labels: { x: number; text: string }[] = [];
  private canvas: CanvasRenderingContext2D | null = null;
  private static readonly FONT = 11;
  private static readonly SPACING = 16;

  constructor(private colors: { profit: string; loss: string; text: string }) {}

  private readonly linesView = paneView("top", (t) =>
    t.useBitmapCoordinateSpace(({ context: ctx, horizontalPixelRatio: hr, verticalPixelRatio: vr }) => {
      const l = this.lines;
      if (!l) return;
      ctx.save();
      ctx.setLineDash([3 * vr, 3 * vr]);
      ctx.lineWidth = 2 * hr;
      for (const [x, color] of [[l.profit, this.colors.profit], [l.loss, this.colors.loss]] as const) {
        if (!x) continue;
        ctx.strokeStyle = color;
        ctx.beginPath();
        ctx.moveTo(x * hr, 0);
        ctx.lineTo(x * hr, l.height * vr);
        ctx.stroke();
      }
      ctx.restore();
    }),
  );

  private readonly axisView: IPrimitivePaneView = paneView("normal", (t) =>
    t.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      if (!this.labels.length) return;
      ctx.save();
      ctx.font = `${ReturnsOverlay.FONT}px ${CHART_FONT}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = this.colors.text;
      const kept: { x: number; w: number }[] = [];
      for (const l of [...this.labels].sort((a, b) => a.x - b.x)) {
        const w = ctx.measureText(l.text).width;
        // Inside the axis, clear of the labels kept.
        if (w > mediaSize.width || l.x - w / 2 < 0 || l.x + w / 2 > mediaSize.width) continue;
        if (kept.some((k) => Math.abs(l.x - k.x) < w / 2 + k.w / 2 + ReturnsOverlay.SPACING)) continue;
        kept.push({ x: l.x, w });
        ctx.fillText(l.text, l.x, mediaSize.height / 2);
      }
      ctx.restore();
    }),
  );

  attached(p: SeriesAttachedParameter<Time>): void {
    this.chart = p.chart;
    this.series = p.series as ISeriesApi<"Custom", Time, CountBarsData>;
    this.requestUpdate = p.requestUpdate;
  }

  detached(): void {
    this.chart = this.series = this.requestUpdate = null;
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return [this.linesView];
  }

  timeAxisPaneViews(): readonly IPrimitivePaneView[] {
    return [this.axisView];
  }

  setData(bins: ReturnBin[], averages: { profit: number | null; loss: number | null }): void {
    this.bins = bins;
    this.averages = averages;
    this.requestUpdate?.();
  }

  setColors(colors: { profit: string; loss: string; text: string }): void {
    this.colors = colors;
    this.requestUpdate?.();
  }

  updateAllViews(): void {
    const c = this.chart;
    const s = this.series;
    this.lines = null;
    this.labels = [];
    if (!c || !s || !this.bins.length) return;
    const zero = s.priceToCoordinate(0);
    const profit = xOf(c, this.bins, this.averages.profit);
    const loss = xOf(c, this.bins, this.averages.loss);
    if ((profit !== null || loss !== null) && zero !== null) this.lines = { profit, loss, height: zero };
    this.labels = this.axisLabels(c.timeScale().width());
  }

  /** Labels at multiples of a round step: the step nearest above the range / the labels that fit. */
  private axisLabels(width: number): { x: number; text: string }[] {
    const c = this.chart!;
    const min = Math.min(...this.bins.map((b) => b.rangeStart));
    const max = Math.max(...this.bins.map((b) => b.rangeEnd));
    if (!this.canvas) this.canvas = document.createElement("canvas").getContext("2d");
    const ctx = this.canvas;
    if (!ctx || width <= 0) return [];
    ctx.font = `${ReturnsOverlay.FONT}px ${CHART_FONT}`;
    const full = 1.05 * (Math.max(ctx.measureText(boundText(min)).width, ctx.measureText(boundText(max)).width) + ReturnsOverlay.SPACING);
    const per = (max - min) / Math.max(1, Math.floor(width / full));
    const step = STEPS.find((s) => s >= per);
    if (step === undefined) return [];
    const out: { x: number; text: string }[] = [];
    for (let k = Math.trunc(min / step); k * step <= max + step; k++) {
      const v = Number((k * step).toFixed(10));
      if (v < min - step || v > max + step) continue;
      const x = xOf(c, this.bins, v);
      if (x !== null) out.push({ x, text: pct(v) });
    }
    return out;
  }
}

export function ReturnsHistogram(props: { report: BacktestReport }) {
  let host!: HTMLDivElement;
  let chart: IChartApi | null = null;
  let series: ISeriesApi<"Custom", Time, CountBarsData> | null = null;
  let zero: IPriceLine | null = null;
  let hover: HoverBar | null = null;
  let overlay: ReturnsOverlay | null = null;
  const bins = createMemo(() => returnBins(props.report));
  const averages = createMemo(() => averageReturns(props.report));
  const [tip, setTip] = createSignal<{ anchor: TipAnchor; bin: ReturnBin } | null>(null);

  const onMove = (p: MouseEventParams<Time>) => {
    // Bins with trades only (an empty bin is no bar).
    const bin = p.point && p.time !== undefined && series && p.seriesData.get(series) ? bins()[p.time as number] : undefined;
    const x = bin && chart ? chart.timeScale().timeToCoordinate(p.time!) : null;
    if (!bin || x === null) return setTip(null);
    const r = host.getBoundingClientRect();
    setTip({ anchor: { x: r.left + x, y: r.top, el: host }, bin });
  };

  onMount(() => {
    const c = colors();
    chart = createChart(host, {
      autoSize: true,
      trackingMode: { exitMode: TrackingModeExitMode.OnTouchEnd },
      layout: { attributionLogo: false, background: { color: "transparent" }, textColor: c.text, fontFamily: CHART_FONT },
      grid: { vertLines: { visible: false }, horzLines: { visible: true, color: c.grid } },
      rightPriceScale: { visible: true, borderVisible: false, entireTextOnly: true, scaleMargins: { top: 0.1, bottom: 0.1 }, alignLabels: true, autoScale: true },
      leftPriceScale: { visible: false },
      timeScale: { borderVisible: false, lockVisibleTimeRangeOnResize: true, allowBoldLabels: false, tickMarkFormatter: () => "" },
      crosshair: { horzLine: { visible: false, labelVisible: false }, vertLine: { visible: false, labelVisible: false } },
      handleScale: false,
      handleScroll: false,
    });
    series = chart.addCustomSeries(new CountBarsSeries(), {
      priceFormat: { type: "volume", precision: 0, minMove: 1 },
      lastValueVisible: false,
      priceLineVisible: false,
      widthPercent: 60,
      radius: 2,
      barPaddingFromZeroLine: 2,
    }) as ISeriesApi<"Custom", Time, CountBarsData>;
    zero = series.createPriceLine({ price: 0, color: c.zero, lineWidth: 1, lineStyle: LineStyle.Solid, axisLabelVisible: false });
    overlay = new ReturnsOverlay({ profit: c.averageProfit, loss: c.averageLoss, text: c.text });
    hover = new HoverBar({ color: c.hovered });
    series.attachPrimitive(overlay);
    series.attachPrimitive(hover);
    chart.subscribeCrosshairMove(onMove);
    onCleanup(() => {
      setTip(null);
      chart?.unsubscribeCrosshairMove(onMove);
      chart?.remove();
      chart = null;
    });
  });

  createEffect(() => {
    const c = colors();
    const bs = bins();
    if (!series || !chart) return;
    // Bins on index slots (evenly spaced, like their middles).
    series.setData(bs.map((b, i) => ({ time: i as Time, value: b.tradesCount, barColor: b.isProfit ? c.profit : c.loss })));
    overlay?.setData(bs, averages());
    chart.timeScale().fitContent();
  });

  createEffect(
    on(reportTheme, () => {
      const c = colors();
      chart?.applyOptions({ layout: { textColor: c.text }, grid: { horzLines: { color: c.grid } } });
      zero?.applyOptions({ color: c.zero });
      overlay?.setColors({ profit: c.averageProfit, loss: c.averageLoss, text: c.text });
      hover?.setColor(c.hovered);
    }, { defer: true }),
  );

  const average = (label: string, value: number | null, color: string) => (
    <div class="st-avg-item">
      <span class="st-avg-icon" style={{ color }}>
        <Icon name="st-average-line" />
      </span>
      <span class="st-avg-label">{label}</span>
      <span class="st-avg-value">{value === null ? DASH : percent(value)}</span>
    </div>
  );

  return (
    <Widget title="Returns distribution" hasData={bins().length > 0} half smallTitleMargin minHeight={194}>
      <div ref={host} class="st-returns-chart" />
      <div class="st-returns-legend">
        <Legend items={[{ label: "Losers", color: colors().loss }, { label: "Winners", color: colors().profit }]} class="is-gap-16" />
        <div class="st-returns-averages">
          {average("Average loss", averages().loss, colors().averageLoss)}
          {average("Average profit", averages().profit, colors().averageProfit)}
        </div>
      </div>
      <Show when={tip()}>
        {(t) => {
          const b = () => t().bin;
          return (
            <ChartTip
              anchor={t().anchor}
              offset={0}
              rows={[
                {
                  title: "Range",
                  leftAlign: true,
                  value: (
                    <>
                      <span>{percent(b().originalRangeStart ?? b().rangeStart)}</span>
                      <span class="st-tip-dash">—</span>
                      <span>{percent(b().originalRangeEnd ?? b().rangeEnd)}</span>
                    </>
                  ),
                },
                { title: "Trades", leftAlign: true, value: String(b().tradesCount) },
              ]}
            />
          );
        }}
      </Show>
    </Widget>
  );
}
