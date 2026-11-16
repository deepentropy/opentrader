/*
 * Mini chart (#339): one symbol's logo and ticker, its last price, currency
 * and day change, over an area chart of its closes on the chosen range (one
 * year when none is set). The area is drawn in the up colour when the range
 * ends higher than it starts, in the down colour otherwise. A click tells the
 * page.
 */
import { createEffect, onCleanup, onMount } from "solid-js";
import { AreaSeries, createChart, TickMarkType, type IChartApi, type ISeriesApi, type Time, type UTCTimestamp } from "lightweight-charts";
import type { EmbedConfig, EmbedRange } from "../config";
import { getBars, tickerOf } from "../../data/datafeed";
import { displayTimeZone } from "../../data/session";
import { dateText } from "../../i18n/format";
import { createWidgetQuotes } from "./widget-quotes";
import { moveClass, percentText, pickSymbol, priceText, SymbolLogo } from "./parts";

const DAY = 86_400;

/** The bars a range is drawn from: their interval, and which of them it keeps (times in seconds, ascending). */
export const RANGE_BARS: Record<EmbedRange, { interval: string; keep: (times: number[]) => number }> = {
  // The last session: the bars within 12 hours of the last one (sessions are further apart).
  "1D": { interval: "5", keep: (t) => t[t.length - 1] - DAY / 2 },
  // The last five days with bars.
  "5D": { interval: "30", keep: (t) => fromLastDays(t, 5) },
  "1M": { interval: "1D", keep: (t) => t[t.length - 1] - 31 * DAY },
  "3M": { interval: "1D", keep: (t) => t[t.length - 1] - 92 * DAY },
  "6M": { interval: "1D", keep: (t) => t[t.length - 1] - 183 * DAY },
  YTD: { interval: "1D", keep: (t) => Date.UTC(new Date(t[t.length - 1] * 1000).getUTCFullYear(), 0, 1) / 1000 },
  "1Y": { interval: "1D", keep: (t) => t[t.length - 1] - 366 * DAY },
  "5Y": { interval: "1W", keep: (t) => t[t.length - 1] - 5 * 366 * DAY },
  All: { interval: "1M", keep: () => -Infinity },
};

/** First time of the last `n` days that have bars. */
function fromLastDays(times: number[], n: number): number {
  const days: number[] = [];
  for (let i = times.length - 1; i >= 0; i--) {
    const day = Math.floor(times[i] / DAY);
    if (days[days.length - 1] !== day) {
      if (days.length === n) return times[i + 1];
      days.push(day);
    }
  }
  return times[0] ?? 0;
}

/** Axis labels in the app's language, at the symbol's exchange time (the bars are in UTC). */
function tickLabel(time: Time, type: TickMarkType, zone: string): string {
  const d = new Date((time as number) * 1000);
  switch (type) {
    case TickMarkType.Year:
      return dateText(d, { year: "numeric" }, zone);
    case TickMarkType.Month:
      return dateText(d, { month: "short" }, zone);
    case TickMarkType.DayOfMonth:
      return dateText(d, { day: "numeric", month: "short" }, zone);
    default:
      return dateText(d, { hour: "2-digit", minute: "2-digit" }, zone);
  }
}

const cssVar = (name: string, fallback: string): string =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

/** A colour with an alpha (hex colours; others are kept as they are). */
function faded(color: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(color);
  return m ? `#${m[1]}${Math.round(alpha * 255).toString(16).padStart(2, "0")}` : color;
}

export function MiniChart(props: { config: EmbedConfig; theme: () => string }) {
  const s = props.config.symbol;
  const range = props.config.range ?? "1Y";
  const data = createWidgetQuotes(() => [s]);
  const q = () => data.quotes[s];
  const info = () => data.infos[s];

  let box: HTMLDivElement | undefined;
  let chart: IChartApi | undefined;
  let series: ISeriesApi<"Area"> | undefined;
  let rising = true;

  const paint = () => {
    if (!chart || !series) return;
    const line = rising ? cssVar("--ot-chart-up", "#089981") : cssVar("--ot-chart-down", "#f23645");
    chart.applyOptions({
      layout: { background: { color: "transparent" }, textColor: cssVar("--ot-chart-text", "#787b86"), attributionLogo: false },
    });
    series.applyOptions({ lineColor: line, topColor: faded(line, 0.28), bottomColor: faded(line, 0) });
  };

  onMount(() => {
    if (!box) return;
    const zone = displayTimeZone("Exchange", "America/New_York", s);
    const intraday = range === "1D" || range === "5D";
    chart = createChart(box, {
      autoSize: true,
      localization: {
        timeFormatter: (t: Time) => dateText(new Date((t as number) * 1000), intraday ? { dateStyle: "medium", timeStyle: "short" } : { dateStyle: "medium" }, intraday ? zone : "UTC"),
      },
      handleScroll: false,
      handleScale: false,
      grid: { vertLines: { visible: false }, horzLines: { visible: false } },
      rightPriceScale: { visible: false },
      leftPriceScale: { visible: false },
      timeScale: {
        borderVisible: false,
        fixLeftEdge: true,
        fixRightEdge: true,
        timeVisible: intraday,
        // Daily bars are stamped at midnight UTC: their dates read in UTC.
        tickMarkFormatter: (t: Time, type: TickMarkType) => tickLabel(t, type, intraday ? zone : "UTC"),
      },
      crosshair: { horzLine: { visible: false, labelVisible: false }, vertLine: { labelVisible: false } },
    });
    series = chart.addSeries(AreaSeries, { lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerRadius: 3 });
    paint();
    let alive = true;
    const plan = RANGE_BARS[range];
    getBars(s, plan.interval, "RTH", () => alive)
      .then((r) => {
        if (!alive || !series || !r.bars.length) return;
        const times = r.bars.map((b) => b.time as number);
        const from = plan.keep(times);
        const shown: { time: UTCTimestamp; value: number }[] = [];
        for (const b of r.bars) if ((b.time as number) >= from && b.close != null) shown.push({ time: b.time as UTCTimestamp, value: b.close });
        rising = shown.length < 2 || shown[shown.length - 1].value >= shown[0].value;
        series.setData(shown);
        paint();
        chart?.timeScale().fitContent();
      })
      .catch((e) => console.warn(`[embed] ${s} bars: ${e}`));
    onCleanup(() => {
      alive = false;
      chart?.remove();
      chart = undefined;
    });
  });
  // A theme change repaints with the new colours.
  createEffect(() => {
    props.theme();
    paint();
  });

  return (
    <div class="ot-w-mini" onClick={() => pickSymbol(s)} role="button" tabIndex={0}>
      <div class="ot-w-mini-head">
        <SymbolLogo symbol={s} url={info()?.logo} size={24} />
        <span class="ot-w-ticker" data-no-translate>{tickerOf(s)}</span>
      </div>
      <div class="ot-w-mini-values">
        <span class="ot-w-last ot-value">{priceText(q()?.last)}</span>
        <span class="ot-w-currency" data-no-translate>{info()?.currency?.toUpperCase() ?? ""}</span>
        <span class={`ot-w-change ot-value ${moveClass(q()?.changePercent)}`}>{percentText(q()?.changePercent)}</span>
      </div>
      <div ref={box} class="ot-w-mini-chart" />
    </div>
  );
}
