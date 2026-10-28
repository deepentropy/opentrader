/*
 * Periodical charts of the Performance analysis tabs (the reference app
 * modules 172467 and 951347):
 * - Periodical: "Weekly PnL" (Daily / Quarterly / Yearly with the switch):
 *   per bucket the realized profit or loss over the favorable and adverse
 *   excursions of its running PnL (metrics.periodicals); 20 px minimum bar
 *   spacing (16 under a 526 px container).
 * - Benchmarking: "Strategy vs benchmark", the strategy PnL and the buy and
 *   hold PnL change side by side per bucket (metrics.benchmarking); 64 px.
 * Buckets come from the closed trades' exit times in UTC; empty buckets keep
 * their slot. The details offered are the ones the chart interval allows
 * that hold data (a 1 D chart: Weekly / Quarterly / Yearly). Bars spread over
 * the width or page with the arrows; the pretty scale holds 5 levels of
 * 86.00 K style labels; the hovered slot is shaded and its tooltip floats
 * above the chart.
 */
import { Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import { LineStyle, createChart, type IChartApi, type IPriceLine, type ISeriesApi, type MouseEventParams, type Time } from "lightweight-charts";
import type { BacktestReport } from "../../backtester/types";
import { BUCKET_DETAILS, benchmarking, periodicals, withEmptyBuckets, type BucketBar, type BucketDetail } from "./metrics";
import { HoverBar, PALETTE as P, PrettyPriceScale, chartBase, hoveredBar, quarterLabel, reportTheme, themed, tipMoney, utcDate, volume2, withAlpha } from "./report-chart-kit";
import { BucketBarsSeries, PairBarsSeries, type BucketBarsData } from "./report-series";
import { ChartTip, DetailSwitch, Legend, PagedChart, Widget, signOf, usePager, type TipAnchor, type TipRow } from "./ReportWidget";

const DETAIL_LABEL: Record<BucketDetail, string> = { day: "Daily", week: "Weekly", quarter: "Quarterly", year: "Yearly" };

/** Axis label of a bucket: "Q3 '20", "2020", else "Jul 5". */
function tickLabel(sec: number, d: BucketDetail): string {
  const ms = sec * 1000;
  return d === "quarter" ? quarterLabel(ms) : d === "year" ? utcDate(ms, "year") : utcDate(ms, "monthDay");
}

/** Tooltip date of a bucket: "Jul 5, 2020", "Jul 5 — Jul 11, 2020", "Q3 '20", "2020". */
function bucketDate(ms: number, d: BucketDetail): string {
  if (d === "day") return utcDate(ms, "date");
  if (d === "week") {
    const end = ms + 6 * 86_400_000;
    const sameYear = new Date(ms).getUTCFullYear() === new Date(end).getUTCFullYear();
    return `${utcDate(ms, sameYear ? "monthDay" : "date")} — ${utcDate(end, "date")}`;
  }
  return d === "quarter" ? quarterLabel(ms) : utcDate(ms, "year");
}

type Colors = { bars: string[]; text: string; grid: string; hovered: string; zero: string };
type Hover = { anchor: TipAnchor; time: number; values: number[] };

type Config = {
  title: (d: BucketDetail) => string;
  data: (r: BacktestReport, intervalSec: number) => Record<BucketDetail, BucketBar[]>;
  defaultDetail: BucketDetail;
  minBarSpacing: number;
  narrowLayouts?: { containerWidth: number; minBarSpacing: number }[];
  colors: () => Colors;
  /** Legend entries: [label, color index]. */
  legend: [string, number][];
  addSeries: (chart: IChartApi, colors: Colors) => ISeriesApi<"Custom", Time, BucketBarsData>;
  tipRows: (values: number[], colors: Colors, currency: string) => TipRow[];
};

function BucketChart(props: { config: Config; report: BacktestReport; intervalSec: number }) {
  const cfg = props.config;
  let container!: HTMLDivElement;
  let host!: HTMLDivElement;
  let chart: IChartApi | null = null;
  let series: ISeriesApi<"Custom", Time, BucketBarsData> | null = null;
  let zero: IPriceLine | null = null;
  let scale: PrettyPriceScale<BucketBarsData> | null = null;
  let hover: HoverBar | null = null;

  const data = createMemo(() => cfg.data(props.report, props.intervalSec));
  const available = createMemo(() => BUCKET_DETAILS.filter((d) => data()[d].length > 0));
  const [picked, setPicked] = createSignal<BucketDetail>(cfg.defaultDetail);
  const detail = () => (available().length === 0 || available().includes(picked()) ? picked() : available()[0]);
  const bars = createMemo(() => data()[detail()]);
  const hasData = () => bars().length > 0;
  const [tip, setTip] = createSignal<Hover | null>(null);
  const pager = usePager({ minBarSpacing: cfg.minBarSpacing, narrowLayouts: cfg.narrowLayouts });

  const onMove = (p: MouseEventParams<Time>) => {
    const h = chart && series ? hoveredBar<BucketBarsData>(p, series, true) : null;
    const x = h ? chart!.timeScale().timeToCoordinate(h.time) : null;
    if (!h || x === null) return setTip(null);
    const r = host.getBoundingClientRect();
    setTip({ anchor: { x: r.left + x, y: r.top, el: host }, time: (h.time as number) * 1000, values: h.bar?.values?.length ? h.bar.values : cfg.legend.map(() => 0) });
  };

  onMount(() => {
    const c = cfg.colors();
    chart = createChart(host, {
      ...chartBase(host, c.text),
      timeScale: { borderVisible: false, barSpacing: cfg.minBarSpacing, minBarSpacing: cfg.minBarSpacing, allowBoldLabels: false, tickMarkFormatter: (t: Time) => tickLabel(t as number, detail()) },
      rightPriceScale: { visible: true, autoScale: true, borderVisible: false, scaleMargins: { top: 0.1, bottom: 0.1 } },
      localization: { locale: "en-US", priceFormatter: volume2 },
    });
    series = cfg.addSeries(chart, c);
    zero = series.createPriceLine({ price: 0, color: c.zero, lineWidth: 1, lineStyle: LineStyle.Solid, axisLabelVisible: false });
    hover = new HoverBar({ color: c.hovered, fullPane: true, whitespace: true, lone: true });
    series.attachPrimitive(hover);
    scale = new PrettyPriceScale<BucketBarsData>({ grid: c.grid, text: c.text }, (d) => d.values ?? [], volume2);
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
    const d = detail();
    const slots = withEmptyBuckets(bars(), d) as BucketBarsData[];
    if (!series) return;
    series.setData(slots);
    chart?.timeScale().applyOptions({});
    pager.setItemCount(slots.length);
  });

  createEffect(
    on(reportTheme, () => {
      const c = cfg.colors();
      chart?.applyOptions({ layout: { textColor: c.text } });
      series?.applyOptions({ colors: c.bars } as never);
      hover?.setColor(c.hovered);
      scale?.setColors({ grid: c.grid, text: c.text });
      zero?.applyOptions({ color: c.zero });
    }, { defer: true }),
  );

  const legend = () => {
    const c = cfg.colors();
    return cfg.legend.map(([label, i]) => ({ label, color: c.bars[i] }));
  };

  return (
    <Widget
      title={cfg.title(detail())}
      hasData={hasData()}
      alwaysActions
      minHeight={280}
      stubSize="medium"
      actions={<DetailSwitch value={detail()} options={available()} label={(d) => DETAIL_LABEL[d]} onChange={setPicked} />}
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
      <Legend items={legend()} class="is-gap-10" />
      <Show when={tip()}>
        {(t) => <ChartTip anchor={t().anchor} columns={2} rows={cfg.tipRows(t().values, cfg.colors(), props.report.currency)} foot={bucketDate(t().time, detail())} />}
      </Show>
    </Widget>
  );
}

// Periodical: [favorable excursion, realized profit, adverse excursion, realized loss].
const periodicalColors = (): Colors =>
  themed(
    { bars: [P.green800, P.green600, P.red800, P.red600], text: P.white, grid: P.gray800, hovered: withAlpha(P.gray800, 0.5), zero: P.gray450 },
    { bars: [P.green50, P.green400, P.red50, P.red400], text: P.gray900, grid: P.gray100, hovered: withAlpha(P.gray100, 0.5), zero: P.gray550 },
  );

const PERIODICAL: Config = {
  title: (d) => `${DETAIL_LABEL[d]} PnL`,
  data: periodicals,
  defaultDetail: "day",
  minBarSpacing: 20,
  narrowLayouts: [{ containerWidth: 526, minBarSpacing: 16 }],
  colors: periodicalColors,
  legend: [["Realized profit", 1], ["Realized loss", 3], ["Favorable excursion", 0], ["Adverse excursion", 2]],
  addSeries: (chart, c) =>
    chart.addCustomSeries(new BucketBarsSeries(), {
      colors: c.bars,
      borderRadius: [4, 4, 4, 4],
      maxColumnWidth: 80,
      columnPadding: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    }) as ISeriesApi<"Custom", Time, BucketBarsData>,
  tipRows: ([fav, profit, adv, loss], c, cur) => {
    const realized = loss < 0 ? loss : profit;
    return [
      { title: realized >= 0 ? "Realized profit" : "Realized loss", color: realized >= 0 ? c.bars[1] : c.bars[3], value: tipMoney(realized, true), unit: cur, positive: signOf(realized) },
      { title: "Favorable excursion", color: c.bars[0], value: tipMoney(fav, true), unit: cur, positive: signOf(fav) },
      { title: "Adverse excursion", color: c.bars[2], value: tipMoney(adv, true), unit: cur, positive: signOf(adv) },
    ];
  },
};

// Benchmarking: [strategy, buy and hold].
const benchmarkColors = (): Colors =>
  themed(
    { bars: [P.blue400, P.gray650], text: P.white, grid: P.gray800, hovered: withAlpha(P.gray800, 0.5), zero: P.gray450 },
    { bars: [P.blue400, P.gray250], text: P.gray900, grid: P.gray100, hovered: withAlpha(P.gray100, 0.5), zero: P.gray550 },
  );

const BENCHMARK: Config = {
  title: () => "Strategy vs benchmark",
  data: benchmarking,
  defaultDetail: "week",
  minBarSpacing: 64,
  colors: benchmarkColors,
  legend: [["Strategy PnL", 0], ["Buy and hold PnL", 1]],
  addSeries: (chart, c) => chart.addCustomSeries(new PairBarsSeries(), { colors: c.bars, priceLineVisible: false, lastValueVisible: false }) as ISeriesApi<"Custom", Time, BucketBarsData>,
  tipRows: ([strategy = 0, bh = 0], c, cur) => [
    { title: "Strategy PnL", color: c.bars[0], value: tipMoney(strategy, true), unit: cur, positive: signOf(strategy) },
    { title: "Buy and hold PnL", color: c.bars[1], value: tipMoney(bh, true), unit: cur, positive: signOf(bh) },
  ],
};

export function PeriodicalChart(props: { report: BacktestReport; intervalSec: number }) {
  return <BucketChart config={PERIODICAL} report={props.report} intervalSec={props.intervalSec} />;
}

export function BenchmarkChart(props: { report: BacktestReport; intervalSec: number }) {
  return <BucketChart config={BENCHMARK} report={props.report} intervalSec={props.intervalSec} />;
}
