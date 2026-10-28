/*
 * "Results by time" of the Time patterns tab (the reference app module
 * 580131): winning and losing trades by entry hour, weekday or month
 * (metrics.entryBuckets; the units the chart interval allows, the switch
 * hidden with one), the winners' bar over the bar of all the trades, so the
 * losers read on top. Columns half the 32 px slot (two thirds of 24 / 18 px
 * slots under 960 / 720 px containers), at most 80 px; integer levels.
 */
import { Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import { LineStyle, createChart, type IChartApi, type IPriceLine, type ISeriesApi, type MouseEventParams, type Time } from "lightweight-charts";
import { count } from "./format";
import type { EntryBuckets, TimeUnit } from "./metrics";
import { HoverBar, PALETTE as P, PrettyPriceScale, chartBase, reportTheme, themed, withAlpha } from "./report-chart-kit";
import { BucketBarsSeries, type BucketBarsData } from "./report-series";
import { ChartTip, DetailSwitch, Legend, PagedChart, Widget, usePager, type TipAnchor } from "./ReportWidget";

const UNITS: readonly TimeUnit[] = ["hour", "day", "month"];
const UNIT_LABEL: Record<TimeUnit, string> = { hour: "Hours", day: "Days", month: "Months" };
const LAYOUT = [1, 2, 1] as const;
const NARROW_LAYOUT = [1, 4, 1] as const;

const colors = () =>
  themed(
    { winners: P.green600, losers: P.red600, text: P.white, grid: P.gray800, hovered: withAlpha(P.gray800, 0.5), zero: P.gray450 },
    { winners: P.green400, losers: P.red400, text: P.gray900, grid: P.gray100, hovered: withAlpha(P.gray100, 0.5), zero: P.gray550 },
  );

const hourOf = (sec: number) => `${String(new Date(sec * 1000).getUTCHours()).padStart(2, "0")}:00`;
const weekday = (sec: number, long: boolean) => new Date(sec * 1000).toLocaleDateString("en-US", { weekday: long ? "long" : "short", timeZone: "UTC" });
const month = (sec: number, long: boolean) => new Date(sec * 1000).toLocaleDateString("en-US", { month: long ? "long" : "short", timeZone: "UTC" });

/** Slot time of bucket i: that hour of today, that weekday of this week, that month of this year (UTC). */
function slotTime(unit: TimeUnit, i: number): number {
  const d = new Date();
  const y = d.getUTCFullYear();
  if (unit === "hour") return Date.UTC(y, d.getUTCMonth(), d.getUTCDate(), i) / 1000;
  if (unit === "day") return Date.UTC(y, d.getUTCMonth(), d.getUTCDate() - d.getUTCDay() + i) / 1000;
  return Date.UTC(y, i, 1) / 1000;
}

/** Tooltip footer: "14:00 — 14:59", "Sunday", "January". */
function bucketLabel(sec: number, unit: TimeUnit): string {
  if (unit === "hour") return `${hourOf(sec)} — ${String(new Date(sec * 1000).getUTCHours()).padStart(2, "0")}:59`;
  return unit === "month" ? month(sec, true) : weekday(sec, true);
}

const trades = (n: number) => `${n} trade${n === 1 ? "" : "s"}`;

export function ResultsByTime(props: { buckets: EntryBuckets }) {
  let container!: HTMLDivElement;
  let host!: HTMLDivElement;
  let chart: IChartApi | null = null;
  let series: ISeriesApi<"Custom", Time, BucketBarsData> | null = null;
  let zero: IPriceLine | null = null;
  let scale: PrettyPriceScale<BucketBarsData> | null = null;
  let hover: HoverBar | null = null;
  const available = createMemo(() => UNITS.filter((u) => props.buckets[u].length > 0));
  const [picked, setPicked] = createSignal<TimeUnit>("hour");
  const unit = () => (available().length === 0 || available().includes(picked()) ? picked() : available()[0]);
  const slots = createMemo(() => props.buckets[unit()].map((b, i) => ({ time: slotTime(unit(), i), ...b })));
  const [tip, setTip] = createSignal<{ anchor: TipAnchor; time: number; winners: number; losers: number } | null>(null);
  const pager = usePager({ minBarSpacing: 32, narrowLayouts: [{ containerWidth: 960, minBarSpacing: 24 }, { containerWidth: 720, minBarSpacing: 18 }] });

  const tick = (sec: number) => (unit() === "hour" ? hourOf(sec) : unit() === "month" ? month(sec, false) : weekday(sec, false));

  const onMove = (p: MouseEventParams<Time>) => {
    const s = p.point && p.logical !== undefined && p.time !== undefined ? slots()[p.logical] : undefined;
    const x = s && chart ? chart.timeScale().timeToCoordinate(p.time!) : null;
    if (!s || x === null) return setTip(null);
    const r = host.getBoundingClientRect();
    setTip({ anchor: { x: r.left + x, y: r.top, el: host }, time: s.time, winners: s.winning, losers: s.losing });
  };

  onMount(() => {
    const c = colors();
    chart = createChart(host, {
      ...chartBase(host, c.text),
      timeScale: { borderVisible: false, barSpacing: 32, minBarSpacing: 32, allowBoldLabels: false, tickMarkFormatter: (t: Time) => tick(t as number) },
      rightPriceScale: { visible: true, autoScale: true, borderVisible: false, scaleMargins: { top: 0.1, bottom: 0.03 } },
      localization: { locale: "en-US", priceFormatter: (v: number) => count(v) },
    });
    series = chart.addCustomSeries(new BucketBarsSeries(), {
      maxColumnWidth: 80,
      layout: LAYOUT,
      borderRadius: [2, 2, 0, 0],
      colors: [c.losers, c.winners, c.losers, c.winners],
      priceLineVisible: false,
      lastValueVisible: false,
    }) as ISeriesApi<"Custom", Time, BucketBarsData>;
    zero = series.createPriceLine({ price: 0, color: c.zero, lineWidth: 1, lineStyle: LineStyle.Solid, axisLabelVisible: false });
    hover = new HoverBar({ color: c.hovered, fullPane: true });
    series.attachPrimitive(hover);
    scale = new PrettyPriceScale<BucketBarsData>({ grid: c.grid, text: c.text }, (d) => d.values ?? [], (v) => count(v), true);
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
    const pts = slots().map((s) => ({ time: s.time as Time, values: [s.winning + s.losing, s.winning, 0, 0] }));
    if (!series) return;
    series.setData(pts);
    chart?.timeScale().applyOptions({});
    pager.setItemCount(pts.length);
  });

  // Narrow containers: wider columns.
  createEffect(() => series?.applyOptions({ layout: pager.breakpoint() === -1 ? LAYOUT : NARROW_LAYOUT } as never));

  createEffect(
    on(reportTheme, () => {
      const c = colors();
      chart?.applyOptions({ layout: { textColor: c.text } });
      series?.applyOptions({ colors: [c.losers, c.winners, c.losers, c.winners] } as never);
      scale?.setColors({ grid: c.grid, text: c.text });
      zero?.applyOptions({ color: c.zero });
      hover?.setColor(c.hovered);
    }, { defer: true }),
  );

  return (
    <Widget
      title="Results by time"
      hasData={slots().length > 0}
      alwaysActions
      minHeight={280}
      stubSize="medium"
      actions={<DetailSwitch value={unit()} options={available()} label={(u) => UNIT_LABEL[u]} onChange={setPicked} />}
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
      <Legend items={[{ label: "Winners", color: colors().winners }, { label: "Losers", color: colors().losers }]} class="is-gap-10" />
      <Show when={tip()}>
        {(t) => (
          <ChartTip
            anchor={t().anchor}
            rows={[
              { title: "Winners", color: colors().winners, value: trades(t().winners) },
              { title: "Losers", color: colors().losers, value: trades(t().losers) },
            ]}
            foot={bucketLabel(t().time, unit())}
          />
        )}
      </Show>
    </Widget>
  );
}
