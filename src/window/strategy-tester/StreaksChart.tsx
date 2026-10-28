/*
 * "Winning and losing streaks" of the Streaks tab (the reference app module
 * 506112): one bar per closed trade, the length of the streak it extends
 * (Count: winners up, losers down; integer levels, labels without sign) or
 * the streak's PnL so far (Amount). Bars 1 px apart from 6 to 60 px wide
 * slots, paged; no time axis. The tooltip names the trade, its net profit or
 * loss, its return and its exit date.
 */
import { Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import { LineStyle, createChart, type IChartApi, type IPriceLine, type ISeriesApi, type MouseEventParams, type Time } from "lightweight-charts";
import type { BacktestReport } from "../../backtester/types";
import { count as countFormat, money, percent, tradeDate } from "./format";
import { streakBars, type StreakBar } from "./metrics";
import { HoverBar, PALETTE as P, PrettyPriceScale, chartBase, reportTheme, themed, volume2, withAlpha } from "./report-chart-kit";
import { CountBarsSeries, type CountBarsData } from "./report-series";
import { ChartTip, DetailSwitch, Legend, PagedChart, Widget, signOf, usePager, type TipAnchor } from "./ReportWidget";

type Mode = "count" | "amount";
const MODES: readonly Mode[] = ["count", "amount"];

const colors = () =>
  themed(
    { winner: P.green600, loser: P.red600, zero: P.gray450, grid: P.gray800, text: P.gray300, hovered: withAlpha(P.gray800, 0.5) },
    { winner: P.green400, loser: P.red400, zero: P.gray550, grid: P.gray100, text: P.gray900, hovered: withAlpha(P.gray100, 0.5) },
  );

export function StreaksChart(props: { report: BacktestReport; intraday: boolean; timeZone: string }) {
  let container!: HTMLDivElement;
  let host!: HTMLDivElement;
  let chart: IChartApi | null = null;
  let series: ISeriesApi<"Custom", Time, CountBarsData> | null = null;
  let zero: IPriceLine | null = null;
  let scale: PrettyPriceScale<CountBarsData> | null = null;
  let hover: HoverBar | null = null;
  const [mode, setMode] = createSignal<Mode>("count");
  const all = createMemo(() => streakBars(props.report));
  const values = () => all()[mode()];
  const [tip, setTip] = createSignal<{ anchor: TipAnchor; bar: StreakBar } | null>(null);
  const pager = usePager({ minBarSpacing: 6, maxBarSpacing: 60 });
  const format = (v: number) => (mode() === "amount" ? volume2(v) : countFormat(Math.abs(v)));

  const onMove = (p: MouseEventParams<Time>) => {
    const bar = p.point && p.logical !== undefined && p.time !== undefined ? values()[p.logical] : undefined;
    const x = bar && chart ? chart.timeScale().timeToCoordinate(p.time!) : null;
    if (!bar || x === null) return setTip(null);
    const r = host.getBoundingClientRect();
    setTip({ anchor: { x: r.left + x, y: r.top, el: host }, bar });
  };

  onMount(() => {
    const c = colors();
    chart = createChart(host, {
      ...chartBase(host, c.text),
      timeScale: { visible: false, fixLeftEdge: true, barSpacing: 6, minBarSpacing: 6, maxBarSpacing: 60 },
      rightPriceScale: { visible: true, borderVisible: false, autoScale: true, scaleMargins: { top: 0.1, bottom: 0.1 } },
      localization: { locale: "en-US" },
    });
    series = chart.addCustomSeries(new CountBarsSeries(), { priceLineVisible: false, lastValueVisible: false, barPadding: 1, radius: 2 }) as ISeriesApi<"Custom", Time, CountBarsData>;
    zero = series.createPriceLine({ price: 0, color: c.zero, lineWidth: 1, lineStyle: LineStyle.Solid, axisLabelVisible: false });
    hover = new HoverBar({ color: c.hovered, fullPane: true, whitespace: true });
    series.attachPrimitive(hover);
    scale = new PrettyPriceScale<CountBarsData>({ grid: c.grid, text: c.text }, (d) => [d.value], format, true);
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
    const c = colors();
    const pts = values().map((b, i) => ({ time: i as Time, value: b.value, barColor: b.value >= 0 ? c.winner : c.loser }));
    if (!series || !scale) return;
    scale.setInteger(mode() === "count");
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

  return (
    <Widget
      title="Winning and losing streaks"
      hasData={values().length >= 1}
      alwaysActions
      minHeight={280}
      stubSize="medium"
      actions={<DetailSwitch value={mode()} options={MODES} label={(m) => (m === "count" ? "Count" : "Amount")} onChange={setMode} />}
    >
      <PagedChart
        class="st-bucket-chart"
        showArrows={pager.showArrows()}
        canLeft={pager.canLeft()}
        canRight={pager.canRight()}
        onLeft={pager.left}
        onRight={pager.right}
        containerRef={(el) => (container = el)}
        hostRef={(el) => (host = el)}
      />
      <Legend items={[{ label: "Winners", color: colors().winner }, { label: "Losers", color: colors().loser }]} class="is-gap-10" />
      <Show when={tip()}>
        {(t) => (
          <ChartTip
            anchor={t().anchor}
            title={`Trade #${t().bar.tradeNumber} ${t().bar.short ? "Short" : "Long"}`}
            rows={[
              { title: t().bar.profit >= 0 ? "Net profit" : "Net loss", value: money(t().bar.profit, true), unit: props.report.currency, positive: signOf(t().bar.profit) },
              { title: "PnL return", value: percent(t().bar.profitPercent, true), positive: signOf(t().bar.profitPercent) },
            ]}
            foot={tradeDate(t().bar.closeTime, props.intraday, props.timeZone)}
          />
        )}
      </Show>
    </Widget>
  );
}
