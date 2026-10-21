/*
 * Growth and decline tab charts (the reference app modules 17601, 990687 and
 * 392642), side by side from a 930 px report:
 * - "Alternating growth and decline": one bar per run-up / drawdown period
 *   in order, its relative change (% scale); the last period in the darker
 *   "current" shade. 12 px minimum bar spacing, paged; no time axis.
 * - "Comparison of growth and decline periods": Maximum / Average (/ Current
 *   when the last period is of that kind) relative change of the run-ups and
 *   of the drawdowns, as bars scaled to the maximum, the value at the right.
 * Both need 3 periods.
 */
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import { LineStyle, createChart, type IChartApi, type IPriceLine, type ISeriesApi, type MouseEventParams, type Time } from "lightweight-charts";
import type { BacktestReport } from "../../backtester/types";
import type { EquityPeriod } from "./equity-data";
import { money, percent, zoneFormat } from "./format";
import { growthComparison } from "./metrics";
import { HoverBar, PALETTE as P, PrettyPriceScale, chartBase, reportTheme, themed, withAlpha } from "./report-chart-kit";
import { CountBarsSeries, type CountBarsData } from "./report-series";
import { ChartTip, Legend, PagedChart, Widget, usePager, type TipAnchor } from "./ReportWidget";

/** Fewest periods the charts show. */
const MIN_PERIODS = 3;

const colors = () =>
  themed(
    { runup: P.green600, drawdown: P.red600, runupCurrent: P.green800, drawdownCurrent: P.red800, text: P.gray300, grid: P.gray800, zero: P.gray450, hovered: withAlpha(P.gray800, 0.5) },
    { runup: P.green400, drawdown: P.red400, runupCurrent: P.green200, drawdownCurrent: P.red200, text: P.gray900, grid: P.gray100, zero: P.gray550, hovered: withAlpha(P.gray100, 0.5) },
  );

function barColor(p: EquityPeriod, current: boolean, c: ReturnType<typeof colors>): string {
  if (p.type === "runup") return current ? c.runupCurrent : c.runup;
  return current ? c.drawdownCurrent : c.drawdown;
}

/** Periods are the closed-trade PnL run-ups and drawdowns (metrics.growthPeriods); dates in `timeZone`. */
export function AlternatingChart(props: { report: BacktestReport; periods: EquityPeriod[]; timeZone: string }) {
  let container!: HTMLDivElement;
  let host!: HTMLDivElement;
  let chart: IChartApi | null = null;
  let series: ISeriesApi<"Custom", Time, CountBarsData> | null = null;
  let zero: IPriceLine | null = null;
  let scale: PrettyPriceScale<CountBarsData> | null = null;
  let hover: HoverBar | null = null;
  const [tip, setTip] = createSignal<{ anchor: TipAnchor; period: EquityPeriod } | null>(null);
  const pager = usePager({ minBarSpacing: 12 });
  const hasData = () => props.periods.length >= MIN_PERIODS;
  const date = (ms: number) => zoneFormat("en-US", { month: "short", day: "numeric", year: "numeric" }, props.timeZone).format(new Date(ms));

  const points = () => {
    const c = colors();
    const last = props.periods.length - 1;
    return props.periods.map((p, i) => ({ time: i as Time, value: p.relativeChange, barColor: barColor(p, i === last, c) }));
  };

  const onMove = (p: MouseEventParams<Time>) => {
    const period = p.point && p.logical !== undefined && p.time !== undefined ? props.periods[p.logical] : undefined;
    const x = period && chart ? chart.timeScale().timeToCoordinate(p.time!) : null;
    if (!period || x === null) return setTip(null);
    const r = host.getBoundingClientRect();
    setTip({ anchor: { x: r.left + x, y: r.top, el: host }, period });
  };

  onMount(() => {
    const c = colors();
    chart = createChart(host, {
      ...chartBase(host, c.text, 11),
      timeScale: { visible: false, fixLeftEdge: true, fixRightEdge: true, barSpacing: 12 },
      rightPriceScale: { visible: true, borderVisible: false, autoScale: true, scaleMargins: { top: 0.1, bottom: 0.02 } },
      localization: { locale: "en-US", priceFormatter: (v: number) => percent(v) },
    });
    series = chart.addCustomSeries(new CountBarsSeries(), {
      priceFormat: { type: "price", minMove: 1e-4 },
      priceLineVisible: false,
      lastValueVisible: false,
      widthPercent: 70,
      radius: 2,
      barPaddingFromZeroLine: 2,
    }) as ISeriesApi<"Custom", Time, CountBarsData>;
    zero = series.createPriceLine({ price: 0, color: c.zero, lineWidth: 1, lineStyle: LineStyle.Solid, axisLabelVisible: false });
    hover = new HoverBar({ color: c.hovered });
    series.attachPrimitive(hover);
    scale = new PrettyPriceScale<CountBarsData>({ grid: c.grid, text: c.text }, (d) => [d.value], (v) => percent(v));
    series.attachPrimitive(scale);
    chart.subscribeCrosshairMove(onMove);
    pager.attach(chart, container);
    onCleanup(() => {
      setTip(null);
      chart?.unsubscribeCrosshairMove(onMove);
      chart?.remove();
      chart = null;
    });
  });

  createEffect(() => {
    const pts = hasData() ? points() : [];
    if (!series) return;
    series.setData(pts);
    pager.setItemCount(pts.length);
  });

  createEffect(
    on(reportTheme, () => {
      const c = colors();
      scale?.setColors({ grid: c.grid, text: c.text });
      zero?.applyOptions({ color: c.zero });
      hover?.setColor(c.hovered);
    }, { defer: true }),
  );

  const legend = () => {
    const c = colors();
    const lastRunup = props.periods[props.periods.length - 1]?.type === "runup";
    return [
      { label: "Run-up", color: c.runup },
      { label: "Drawdown", color: c.drawdown },
      lastRunup ? { label: "Current run-up", color: c.runupCurrent } : { label: "Current drawdown", color: c.drawdownCurrent },
    ];
  };

  return (
    <Widget title="Alternating growth and decline" hasData={hasData()} half minHeight={280}>
      <PagedChart
        class="st-growth-chart"
        showArrows={pager.showArrows()}
        canLeft={pager.canLeft()}
        canRight={pager.canRight()}
        onLeft={pager.left}
        onRight={pager.right}
        containerRef={(el) => (container = el)}
        hostRef={(el) => (host = el)}
      />
      <Legend items={legend()} class="is-gap-16" />
      <Show when={tip()}>
        {(t) => (
          <ChartTip
            anchor={t().anchor}
            offset={8}
            rows={[
              { title: t().period.type === "drawdown" ? "Drawdown" : "Run-up", value: money(t().period.change), unit: props.report.currency, noPadding: true },
              { value: percent(t().period.relativeChange) },
            ]}
            foot={`${date(t().period.startTime)} — ${date(t().period.endTime)}`}
          />
        )}
      </Show>
    </Widget>
  );
}

export function GrowthComparison(props: { periods: EquityPeriod[] }) {
  const values = createMemo(() => growthComparison(props.periods));
  const width = (v: number, max: number) => (max === 0 ? "0%" : `${(v / max) * 100}%`);
  const block = (title: string, kind: "runup" | "drawdown") => {
    const v = () => values()[kind];
    const c = () => colors();
    const rows = () => [
      { label: "Maximum", value: v().max, color: c()[kind] },
      { label: "Average", value: v().average, color: c()[kind] },
      ...(v().current !== undefined ? [{ label: "Current", value: v().current!, color: kind === "runup" ? c().runupCurrent : c().drawdownCurrent }] : []),
    ];
    return (
      <div class="st-cmp">
        <span class="st-cmp-title">{title}</span>
        <div class="st-cmp-bars">
          <For each={rows()}>
            {(r) => (
              <>
                <span class="st-cmp-label is-name">{r.label}</span>
                <div class="st-cmp-bar" style={{ width: width(r.value, v().max), background: r.color }} />
                <span class="st-cmp-label">{percent(r.value)}</span>
              </>
            )}
          </For>
        </div>
      </div>
    );
  };
  return (
    <Widget title="Comparison of growth and decline periods" hasData={props.periods.length >= MIN_PERIODS} half contentClass="st-cmp-wrap">
      {block("Run-up", "runup")}
      {block("Drawdown", "drawdown")}
    </Widget>
  );
}
