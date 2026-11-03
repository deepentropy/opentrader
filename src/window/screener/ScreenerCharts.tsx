/*
 * Screener Charts view (the reference app 3.5): one small chart per result
 * row, in the table's order, loaded 100 rows at a time as it scrolls.
 *
 * Toolbar (ChartsToolbar, in the control panel): "Chart grid" (Auto: 1 to 4
 * columns by width, rows by height; Custom: a picker up to 4 × 4 "per
 * screen"), "Chart type" (Bars, Candles, Line, Area), "Indicators" (EMA 50,
 * EMA 200, SMA 50, SMA 200, Volume) and "Date range" (1 day on 5 minute bars
 * … All data on monthly bars).
 *
 * A cell: flag, logo, ticker and (setting "Instrument name") the name, then
 * the chart: the series in green or red by the range's change, the moving
 * averages, the volume at the bottom, the price scale on the right. A hover
 * shows the values under the cursor; a click shows the symbol on the chart.
 * Each chart loads its bars once and again after a minute on the next refresh.
 */
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import {
  AreaSeries,
  BarSeries,
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  createChart,
  type IChartApi,
  type Time,
  type TickMarkType,
  type UTCTimestamp,
} from "lightweight-charts";
import { Icon } from "../../components/Icon";
import { getBars } from "../../data/datafeed";
import { timezone } from "../../data/chart-timezone";
import { FLAG_HEX, type FlagColor } from "../../data/watchlist";
import { priceText } from "../../data/screener-format";
import { volumeFormat } from "../../data/volume-format";
import {
  CHART_INDICATORS,
  CHART_RANGES,
  screenerSettings,
  setScreenerSettings,
  type ChartIndicator,
  type ChartRange,
  type ChartType,
} from "../../data/screener-settings";
import { formatAxisTime, formatTick } from "../chart/view/helpers";
import { PopDivider, PopItem, PopSectionTitle, Popover } from "./Popover";
import type { ScanController } from "./scan-controller";

const UP = "#22AB94";
const DOWN = "#F23645";
const GAP = 8;
const FONT = '-apple-system, BlinkMacSystemFont, "Trebuchet MS", Roboto, Ubuntu, sans-serif';
const TYPES: { id: ChartType; label: string; icon: string }[] = [
  { id: "bars", label: "Bars", icon: "menu-candles-bars" },
  { id: "candles", label: "Candles", icon: "menu-candles-candles" },
  { id: "line", label: "Line", icon: "menu-candles-line" },
  { id: "area", label: "Area", icon: "menu-candles-area" },
];

/** Columns by panel width and rows by height (the reference Auto grid). */
export function autoGrid(width: number, height: number): { cols: number; rows: number } {
  const cols = width <= 800 ? 1 : width <= 1500 ? 2 : width <= 1900 ? 3 : 4;
  const rows = height <= 300 ? 1 : height <= 780 ? 2 : height <= 1000 ? 3 : 4;
  return { cols, rows };
}

type Bar = { time: number; open: number; high: number; low: number; close: number; volume: number };

/** The bars of the date range: the last 1 or 5 sessions (New York days), else the months / years before the last bar. */
export function rangeBars(bars: Bar[], range: ChartRange): Bar[] {
  if (!bars.length || range === "All") return bars;
  const last = bars[bars.length - 1].time;
  if (range === "1D" || range === "5D") {
    const day = (t: number) => new Date((t - 5 * 3600) * 1000).toISOString().slice(0, 10);
    const days: string[] = [];
    for (let i = bars.length - 1; i >= 0 && days.length <= (range === "1D" ? 1 : 5); i--) {
      const d = day(bars[i].time);
      if (days[days.length - 1] !== d) days.push(d);
    }
    const first = days[Math.min(days.length - 1, range === "1D" ? 0 : 4)];
    return bars.filter((b) => day(b.time) >= first);
  }
  const d = new Date(last * 1000);
  if (range === "YTD") d.setUTCMonth(0, 1);
  else if (range === "1M") d.setUTCMonth(d.getUTCMonth() - 1);
  else if (range === "3M") d.setUTCMonth(d.getUTCMonth() - 3);
  else if (range === "6M") d.setUTCMonth(d.getUTCMonth() - 6);
  else if (range === "1Y") d.setUTCFullYear(d.getUTCFullYear() - 1);
  else if (range === "5Y") d.setUTCFullYear(d.getUTCFullYear() - 5);
  const from = Math.floor(d.getTime() / 1000);
  return bars.filter((b) => b.time >= from);
}

function movingAverage(bars: Bar[], kind: "ema" | "sma", n: number): (number | null)[] {
  const out: (number | null)[] = [];
  let sum = 0;
  let ema: number | null = null;
  bars.forEach((b, i) => {
    sum += b.close;
    if (i >= n) sum -= bars[i - n].close;
    if (kind === "sma") out.push(i >= n - 1 ? sum / n : null);
    else {
      if (i === n - 1) ema = sum / n;
      else if (ema !== null) ema = (b.close - ema) * (2 / (n + 1)) + ema;
      out.push(ema);
    }
  });
  return out;
}

const chartZone = () => (timezone().label === "Exchange" ? "America/New_York" : timezone().iana);

// Bars kept for the panel's life: a chart scrolled back into view does not load again.
const barCache = new Map<string, { at: number; bars: Bar[] }>();
const RELOAD_MS = 60_000;

function MiniChart(props: { ticker: string; name: string | null; flag: FlagColor | null; refreshTick: number; onPick: () => void }) {
  let host!: HTMLDivElement;
  let chart: IChartApi | null = null;
  const [bars, setBars] = createSignal<Bar[] | null>(null);
  const [failed, setFailed] = createSignal(false);
  const [tip, setTip] = createSignal<{ x: number; y: number; lines: { label: string; value: string; color?: string }[]; time: string } | null>(null);
  let alive = true;
  const seriesList: ReturnType<IChartApi["addSeries"]>[] = [];
  let hover: (index: number, x: number, y: number) => void = () => {};
  onCleanup(() => {
    alive = false;
    chart?.remove();
    chart = null;
  });

  const resolution = () => CHART_RANGES.find((r) => r.id === screenerSettings().chartRange)?.resolution ?? "15";
  const load = async (force: boolean) => {
    const key = `${props.ticker}|${resolution()}`;
    const hit = barCache.get(key);
    if (hit && (!force || Date.now() - hit.at < RELOAD_MS)) {
      setBars(hit.bars);
      return;
    }
    try {
      const res = await getBars(props.ticker, resolution(), "RTH", () => alive);
      const list = res.bars
        .filter((b) => b.time !== null && b.open !== null && b.high !== null && b.low !== null && b.close !== null)
        .map((b) => ({ time: b.time!, open: b.open!, high: b.high!, low: b.low!, close: b.close!, volume: b.volume ?? 0 }));
      barCache.set(key, { at: Date.now(), bars: list });
      if (alive) setBars(list);
    } catch {
      if (alive) setFailed(true);
    }
  };
  createEffect(on(resolution, () => void load(false)));
  createEffect(on(() => props.refreshTick, () => void load(true), { defer: true }));

  onMount(() => {
    chart = createChart(host, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: "#B8B8B8", fontSize: 12, fontFamily: FONT, attributionLogo: false },
      grid: { vertLines: { visible: false }, horzLines: { visible: false } },
      crosshair: { mode: CrosshairMode.Magnet, horzLine: { labelVisible: false }, vertLine: { labelVisible: false } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.1, bottom: 0.08 } },
      timeScale: { borderVisible: false, fixLeftEdge: true, fixRightEdge: true, lockVisibleTimeRangeOnResize: true },
      handleScroll: false,
      handleScale: false,
    });
    chart.subscribeClick(() => props.onPick());
  });

  // Draw: series, moving averages, volume; rebuilt when the bars or the settings change.
  createEffect(() => {
    const all = bars();
    const st = screenerSettings();
    const c = chart;
    if (!c || !all) return;
    for (const s of [...seriesList]) c.removeSeries(s);
    seriesList.length = 0;
    const shown = rangeBars(all, st.chartRange);
    if (!shown.length) return;
    const from = all.length - shown.length;
    const up = shown[shown.length - 1].close >= shown[0].close;
    const color = up ? UP : DOWN;
    const t = (b: Bar) => b.time as UTCTimestamp;
    const intraday = !["1D", "1W", "1M"].includes(resolution());
    c.applyOptions({
      timeScale: { tickMarkFormatter: (time: Time, tt: TickMarkType) => formatTick(time as UTCTimestamp, tt, chartZone(), {}, intraday) },
    });
    if (st.chartIndicators.includes("volume")) {
      const vol = c.addSeries(HistogramSeries, { priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
      c.priceScale("vol").applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
      vol.setData(shown.map((b) => ({ time: t(b), value: b.volume, color: b.close >= b.open ? "rgba(34,171,148,0.5)" : "rgba(242,54,69,0.5)" })));
      seriesList.push(vol);
    }
    const common = { priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false };
    const main =
      st.chartType === "bars"
        ? c.addSeries(BarSeries, { ...common, upColor: UP, downColor: DOWN })
        : st.chartType === "candles"
          ? c.addSeries(CandlestickSeries, { ...common, upColor: UP, downColor: DOWN, wickUpColor: UP, wickDownColor: DOWN, borderVisible: false })
          : st.chartType === "line"
            ? c.addSeries(LineSeries, { ...common, color, lineWidth: 2 })
            : c.addSeries(AreaSeries, { ...common, lineColor: color, lineWidth: 2, topColor: up ? "rgba(34,171,148,0.28)" : "rgba(242,54,69,0.28)", bottomColor: "rgba(0,0,0,0)" });
    if (st.chartType === "bars" || st.chartType === "candles") main.setData(shown.map((b) => ({ time: t(b), open: b.open, high: b.high, low: b.low, close: b.close })));
    else main.setData(shown.map((b) => ({ time: t(b), value: b.close })));
    seriesList.push(main);
    const lines: { label: string; color: string; values: (number | null)[] }[] = [];
    for (const ind of CHART_INDICATORS) {
      if (ind.kind === "volume" || !st.chartIndicators.includes(ind.id)) continue;
      const values = movingAverage(all, ind.kind, ind.length).slice(from);
      const s = c.addSeries(LineSeries, { color: ind.color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
      s.setData(shown.map((b, i) => (values[i] === null ? { time: t(b) } : { time: t(b), value: values[i]! })));
      seriesList.push(s);
      lines.push({ label: ind.label, color: ind.color, values });
    }
    c.timeScale().fitContent();
    hover = (index, x, y) => {
      if (index < 0 || index >= shown.length) return setTip(null);
      const b = shown[index];
      const out = [{ label: props.ticker, value: priceText(b.close), color: b.close >= b.open ? UP : DOWN }];
      if (st.chartIndicators.includes("volume")) out.push({ label: "Vol", value: volumeFormat(b.volume, 2), color: UP });
      for (const l of lines) {
        const v = l.values[index];
        if (v !== null) out.push({ label: l.label, value: priceText(v), color: l.color });
      }
      setTip({ x, y, lines: out, time: formatAxisTime(b.time as UTCTimestamp, chartZone(), intraday, false) });
    };
  });
  onMount(() => {
    chart?.subscribeCrosshairMove((p) => {
      if (!p.point || p.logical === undefined) return setTip(null);
      hover(Math.round(p.logical), p.point.x, p.point.y);
    });
  });

  return (
    <div class="scr-chart-cell" onClick={(e) => e.target === e.currentTarget && props.onPick()}>
      <div class="scr-chart-head" onClick={() => props.onPick()}>
        <Show when={props.flag} keyed>
          {(fl) => (
            <span class="scr-chart-flag" style={{ color: FLAG_HEX[fl] }}>
              <Icon name="scr-flag" />
            </span>
          )}
        </Show>
        <span class="ot-ticker-logo ot-ticker-logo--md" aria-hidden="true">{props.ticker.charAt(0)}</span>
        <span class="scr-ticker-chip" title={props.name ? `${props.ticker} − ${props.name}` : props.ticker}>{props.ticker}</span>
        <Show when={screenerSettings().chartName && props.name}>
          <span class="scr-chart-name">{props.name}</span>
        </Show>
      </div>
      <div class="scr-chart-body" ref={host}>
        <Show when={failed()}>
          <div class="scr-chart-empty">No data</div>
        </Show>
        <Show when={tip()} keyed>
          {(x) => (
            <div class="scr-chart-tip" style={{ left: `${Math.max(4, x.x - 130)}px`, top: "4px" }}>
              <For each={x.lines}>
                {(l) => (
                  <div class="scr-chart-tip-row">
                    <span class="scr-chart-tip-label">{l.label}</span>
                    <span style={{ color: l.color }}>{l.value}</span>
                  </div>
                )}
              </For>
              <div class="scr-chart-tip-time">{x.time}</div>
            </div>
          )}
        </Show>
      </div>
    </div>
  );
}

type Props = {
  ctl: ScanController;
  /** Request fields (the row's description is read from them). */
  fields: string[];
  onPick: (ticker: string) => void;
  flagOf: (ticker: string) => FlagColor | null;
  resetKey: number;
  refreshTick: number;
};

export function ScreenerCharts(props: Props) {
  let scroller!: HTMLDivElement;
  const [size, setSize] = createSignal({ w: 800, h: 600 });
  const [scrollTop, setScrollTop] = createSignal(0);
  const grid = createMemo(() => {
    const g = screenerSettings().chartGrid ?? autoGrid(size().w, size().h);
    return { cols: g.cols, rows: g.rows };
  });
  const cellH = () => Math.max(160, Math.floor((size().h - GAP) / grid().rows));
  const total = () => props.ctl.total() ?? 0;
  const lineCount = () => Math.ceil(total() / grid().cols);
  const visibleLines = createMemo(() => {
    const first = Math.max(0, Math.floor(scrollTop() / cellH()) - 1);
    const last = Math.min(lineCount() - 1, Math.ceil((scrollTop() + size().h) / cellH()));
    const out: number[] = [];
    for (let i = first; i <= last; i++) out.push(i);
    return out;
  });
  createEffect(() => {
    const lines = visibleLines();
    if (!lines.length) return props.ctl.setVisible(0, grid().cols * grid().rows);
    props.ctl.setVisible(lines[0] * grid().cols, (lines[lines.length - 1] + 1) * grid().cols - 1);
  });
  createEffect(
    on(
      () => props.resetKey,
      () => {
        if (scroller) scroller.scrollTop = 0;
        setScrollTop(0);
      },
      { defer: true },
    ),
  );
  onMount(() => {
    const ro = new ResizeObserver(() => setSize({ w: scroller.clientWidth, h: scroller.clientHeight }));
    ro.observe(scroller);
    onCleanup(() => ro.disconnect());
  });
  const descIndex = () => props.fields.indexOf("description");

  return (
    <div class="scr-charts" ref={scroller} onScroll={() => setScrollTop(scroller.scrollTop)}>
      <div class="scr-charts-inner" style={{ height: `${lineCount() * cellH()}px` }}>
        <For each={visibleLines()}>
          {(line) => (
            <div class="scr-charts-line" style={{ top: `${line * cellH()}px`, height: `${cellH()}px`, "grid-template-columns": `repeat(${grid().cols}, minmax(0, 1fr))` }}>
              <For each={Array.from({ length: grid().cols }, (_, k) => line * grid().cols + k).filter((i) => i < total())}>
                {(i) => {
                  const row = () => props.ctl.row(i);
                  return (
                    <Show when={row()?.s} keyed fallback={<div class="scr-chart-cell is-skeleton" />}>
                      {(ticker) => {
                        const name = () => {
                          const d = descIndex() >= 0 ? row()?.d[descIndex()] : null;
                          return typeof d === "string" ? d : null;
                        };
                        return <MiniChart ticker={ticker} name={name()} flag={props.flagOf(ticker)} refreshTick={props.refreshTick} onPick={() => props.onPick(ticker)} />;
                      }}
                    </Show>
                  );
                }}
              </For>
            </div>
          )}
        </For>
      </div>
      <Show when={props.ctl.total() === 0}>
        <div class="scr-empty">No symbols match your filters</div>
      </Show>
    </div>
  );
}

/** The Charts view's toolbar buttons (control panel, after the view button). */
export function ChartsToolbar() {
  const [open, setOpen] = createSignal<"grid" | "type" | "ind" | "range" | null>(null);
  const [hoverCell, setHoverCell] = createSignal<{ cols: number; rows: number } | null>(null);
  const refs: Partial<Record<"grid" | "type" | "ind" | "range", HTMLButtonElement>> = {};
  const st = screenerSettings;
  const toggle = (k: "grid" | "type" | "ind" | "range") => setOpen(open() === k ? null : k);
  const type = () => TYPES.find((x) => x.id === st().chartType) ?? TYPES[3];
  const indCount = () => st().chartIndicators.length;
  const gridLabel = () => {
    const g = st().chartGrid;
    return g ? `${g.cols} × ${g.rows}` : "Auto";
  };
  const toggleInd = (id: ChartIndicator) => {
    const cur = st().chartIndicators;
    setScreenerSettings({ chartIndicators: cur.includes(id) ? cur.filter((x) => x !== id) : CHART_INDICATORS.map((x) => x.id).filter((x) => x === id || cur.includes(x)) });
  };
  const Btn = (p: { k: "grid" | "type" | "ind" | "range"; icon?: string; label: string; title: string }) => (
    <button
      ref={(el) => (refs[p.k] = el)}
      type="button"
      class="scr-light-btn scr-light-btn--ghost scr-view-tool"
      classList={{ "is-open": open() === p.k }}
      title={p.title}
      onClick={() => toggle(p.k)}
    >
      <Show when={p.icon}>
        <Icon name={p.icon!} size={28} />
      </Show>
      <span class="scr-light-btn-text">{p.label}</span>
      <span class="scr-sets-caret" classList={{ "is-open": open() === p.k }}><Icon name="scr-caret-small" size={18} /></span>
    </button>
  );
  return (
    <>
      <Btn k="grid" icon="scr-chart-grid" label={gridLabel()} title="Chart grid" />
      <Btn k="type" icon={type().icon} label={type().label} title="Chart type" />
      <Btn k="ind" icon="scr-chart-indicators" label={indCount() === 1 ? "1 indicator" : indCount() ? `${indCount()} indicators` : "Indicators"} title="Indicators" />
      <Btn k="range" label={st().chartRange} title="Date range" />

      <Show when={open() === "grid"}>
        <Popover anchor={refs.grid!} onClose={() => setOpen(null)} width={164}>
          <PopSectionTitle title="Chart grid" />
          <PopItem title="Auto" selected={!st().chartGrid} onClick={() => setScreenerSettings({ chartGrid: null })} />
          <PopItem title="Custom" selected={!!st().chartGrid} onClick={() => !st().chartGrid && setScreenerSettings({ chartGrid: { cols: 2, rows: 2 } })} />
          <div class="scr-grid-picker" onMouseLeave={() => setHoverCell(null)}>
            <For each={[1, 2, 3, 4]}>
              {(r) => (
                <For each={[1, 2, 3, 4]}>
                  {(c) => {
                    const g = () => hoverCell() ?? st().chartGrid;
                    return (
                      <button
                        type="button"
                        class="scr-grid-cell"
                        classList={{ "is-on": !!g() && c <= g()!.cols && r <= g()!.rows }}
                        aria-label={`${c} × ${r}`}
                        onMouseEnter={() => setHoverCell({ cols: c, rows: r })}
                        onClick={() => {
                          setScreenerSettings({ chartGrid: { cols: c, rows: r } });
                          setOpen(null);
                        }}
                      />
                    );
                  }}
                </For>
              )}
            </For>
          </div>
          <div class="scr-grid-caption">
            {(() => {
              const g = hoverCell() ?? st().chartGrid;
              return g ? `${g.cols} × ${g.rows} per screen` : "Choose grid";
            })()}
          </div>
        </Popover>
      </Show>
      <Show when={open() === "type"}>
        <Popover anchor={refs.type!} onClose={() => setOpen(null)} width={140}>
          <PopSectionTitle title="Chart type" />
          <For each={TYPES}>
            {(t) => (
              <PopItem
                title={t.label}
                icon={t.icon}
                selected={st().chartType === t.id}
                onClick={() => {
                  setScreenerSettings({ chartType: t.id });
                  setOpen(null);
                }}
              />
            )}
          </For>
        </Popover>
      </Show>
      <Show when={open() === "ind"}>
        <Popover anchor={refs.ind!} onClose={() => setOpen(null)} width={150}>
          <PopSectionTitle title="Indicators" />
          <For each={CHART_INDICATORS}>
            {(ind, i) => (
              <>
                <Show when={i() === 2 || i() === 4}>
                  <PopDivider />
                </Show>
                <div class="scr-item scr-check-item" role="menuitemcheckbox" aria-checked={st().chartIndicators.includes(ind.id)} onClick={() => toggleInd(ind.id)}>
                  <span class="scr-checkbox" classList={{ "is-checked": st().chartIndicators.includes(ind.id) }}>
                    <Show when={st().chartIndicators.includes(ind.id)}>
                      <Icon name="scr-check" size={18} />
                    </Show>
                  </span>
                  <span class="scr-item-text"><span class="scr-item-title">{ind.label}</span></span>
                </div>
              </>
            )}
          </For>
        </Popover>
      </Show>
      <Show when={open() === "range"}>
        <Popover anchor={refs.range!} onClose={() => setOpen(null)} width={180}>
          <PopSectionTitle title="Date range" />
          <For each={CHART_RANGES}>
            {(r) => (
              <PopItem
                title={r.label}
                description={r.resolutionLabel}
                selected={st().chartRange === r.id}
                onClick={() => {
                  setScreenerSettings({ chartRange: r.id });
                  setOpen(null);
                }}
              />
            )}
          </For>
        </Popover>
      </Show>
    </>
  );
}
