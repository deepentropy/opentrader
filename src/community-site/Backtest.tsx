/*
 * A backtest post: a public strategy script run on many stocks. In order: the rules (as code, highlighted), the data
 * it ran on, the results with the author's settings (a period at a time: the whole run, in- or out-of-sample, a year)
 * and a browser of every stock (its chart with the trades, the trade list, the metrics of each period), then the
 * optimized setting and its results. The per-stock table and each stock's bars and trades are files of the post on
 * the server, loaded when shown. Also the Backtests page: the list.
 */
import { For, type JSX, Show, createEffect, createMemo, createResource, createSignal, onCleanup, onMount } from "solid-js";
import type { IChartApi, ISeriesApi, SeriesMarker, Time } from "lightweight-charts";
import {
  BACKTESTS, api, type Backtest, type BacktestPeriod, type BacktestStats, type BacktestStock, type BacktestStockRow, type BacktestSummary, type BacktestTrade, type Post,
} from "../data/community/api";
import { errorText } from "../community-shared/parts";
import { DOWN, FOG, INK, Pills, UP, UserLink, age, tfLong } from "./ui";
import { go } from "./router";

type Setting = "default" | "optimized";

const MINUS = "−";
/** A fraction (0.018) as a signed percent: "+1.80%". */
const signed = (v: number | null | undefined, digits = 2) => (v == null ? "—" : `${v < 0 ? MINUS : "+"}${Math.abs(v * 100).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}%`);
/** A fraction (0.64) as a percent: "64%". */
const share = (v: number | null | undefined) => (v == null ? "—" : `${Math.round(v * 100)}%`);
const ratio = (v: number | null | undefined) => (v == null ? "—" : v.toFixed(2));
const count = (v: number | null | undefined) => (v == null ? "—" : String(Math.round(v)));
const days = (v: number | null | undefined) => (v == null ? "—" : `${Math.round(v)} day${Math.round(v) === 1 ? "" : "s"}`);
const tone = (v: number | null | undefined) => (v == null || v === 0 ? INK : v > 0 ? UP : DOWN);

// The bars are in New York's session: times are shown there, whatever the reader's time zone.
const NY = new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
function nyParts(sec: number) {
  const p = Object.fromEntries(NY.formatToParts(new Date(sec * 1000)).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, min: +p.minute, text: `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}` };
}
/** The New York wall-clock time as if it were UTC: the chart's axis then reads New York times. */
const nyChartTime = (sec: number) => {
  const p = nyParts(sec);
  return (Date.UTC(p.y, p.m - 1, p.d, p.h, p.min) / 1000) as Time;
};
const nyDay = (sec: number) => nyParts(sec).text.slice(0, 10);

/** How long from one time to another: "4 years 11 months", "6 months", "12 days". */
export function duration(from: number, to: number): string {
  const d = Math.max(0, to - from) / 86400;
  const months = Math.round(d / 30.4375);
  if (months < 1) return `${Math.round(d)} day${Math.round(d) === 1 ? "" : "s"}`;
  const y = Math.floor(months / 12);
  const m = months % 12;
  const part = (n: number, unit: string) => (n ? `${n} ${unit}${n === 1 ? "" : "s"}` : "");
  return [part(y, "year"), part(m, "month")].filter(Boolean).join(" ");
}

const span = (p: { first: number; last: number }) => `${nyDay(p.first)} to ${nyDay(p.last)} (${duration(p.first, p.last)})`;

function settingLine(b: Backtest, s: Setting): string {
  return b.inputs.map((i) => `${i.title} ${s === "default" ? i.default : i.optimized}`).join(", ");
}

// ── Rules ───────────────────────────────────────────────────────────────

/** The words of the rules' little language: what a line does, and the words joining conditions. */
const ACTIONS = /^(LONG|SHORT|EXIT|ENTRY|STOP|TARGET|CLOSE)$/;
const WORDS = /^(when|and|or|not|crosses|above|below|over|under|is|if|then|else|none)$/;
const TOKEN = /(\/\/.*$)|(\d+(?:\.\d+)?%?)|([A-Za-z_][A-Za-z0-9_]*)|(=|\+|−|-|×|\*|\/|→|<=|>=|<|>)|(\s+)|(.)/g;

/** The rules as code: actions, joining words, functions, the names the rules define, numbers and operators each in
 *  their colour. */
function RulesCode(props: { text: string }) {
  const lines = () => props.text.split("\n");
  // The names given a value ("Basis = …") read as variables wherever they come.
  const defined = () => new Set(lines().map((l) => /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(l)?.[1]).filter(Boolean) as string[]);
  const line = (l: string): JSX.Element[] => {
    const out: JSX.Element[] = [];
    for (const m of l.matchAll(TOKEN)) {
      const [t, comment, num, word, op] = m;
      const next = l.slice(m.index! + t.length).trimStart();
      const cls = comment ? "is-comment" : num ? "is-num" : op ? "is-op"
        : word ? (ACTIONS.test(word) ? "is-action" : WORDS.test(word) ? "is-word" : next.startsWith("(") ? "is-fn" : defined().has(word) ? "is-var" : "")
        : "";
      out.push(cls ? <span class={cls}>{t}</span> : t);
    }
    return out;
  };
  return (
    <pre class="cs-bt-rules"><code><For each={lines()}>{(l, i) => <>{line(l)}{i() < lines().length - 1 ? "\n" : ""}</>}</For></code></pre>
  );
}

// ── Metrics ─────────────────────────────────────────────────────────────

type Metric = { id: keyof BacktestStats; label: string; fmt: (s: Partial<BacktestStats>) => string; colored?: boolean; account?: boolean };
const METRICS: Metric[] = [
  { id: "trades", label: "Trades", fmt: (s) => count(s.trades) },
  { id: "win_rate", label: "Win rate", fmt: (s) => share(s.win_rate) },
  { id: "profit_factor", label: "Profit factor", fmt: (s) => ratio(s.profit_factor) },
  { id: "avg_trade", label: "Average trade", fmt: (s) => signed(s.avg_trade), colored: true },
  { id: "avg_win", label: "Average win", fmt: (s) => signed(s.avg_win), colored: true },
  { id: "avg_loss", label: "Average loss", fmt: (s) => signed(s.avg_loss), colored: true },
  { id: "largest_win", label: "Largest win", fmt: (s) => signed(s.largest_win), colored: true },
  { id: "largest_loss", label: "Largest loss", fmt: (s) => signed(s.largest_loss), colored: true },
  { id: "avg_days", label: "Time in a trade", fmt: (s) => days(s.avg_days) },
  { id: "long_trades", label: "Long trades", fmt: (s) => (s.long_trades == null ? "—" : `${count(s.long_trades)} · ${share(s.long_win_rate)} won`) },
  { id: "short_trades", label: "Short trades", fmt: (s) => (s.short_trades == null ? "—" : `${count(s.short_trades)} · ${share(s.short_win_rate)} won`) },
  { id: "ret", label: "Account return", fmt: (s) => signed(s.ret), colored: true, account: true },
  { id: "max_dd", label: "Max drawdown", fmt: (s) => share(s.max_dd), account: true },
];

/** An account's return and drawdown say nothing when every order is a fixed size (one share on 100,000: a fraction
 *  of a percent), so those go. */
const fixedSize = (b: Backtest) => /^[\d.]+ (share|contract)s?$/.test(b.costs.order);
const metricsOf = (b: Backtest) => (fixedSize(b) ? METRICS.filter((m) => !m.account) : METRICS);

/** One period across the stocks: the median stock beside all their trades together. */
function SummaryTable(props: { backtest: Backtest; summary: BacktestSummary | undefined }) {
  const rows = () => metricsOf(props.backtest).filter((m) => !m.account);
  return (
    <Show when={props.summary?.pooled} fallback={<p class="cs-note">No closed trade in this period.</p>}>
      <table class="cs-table cs-bt-summary">
        <thead>
          <tr><th /><th class="cs-right-al">Median stock</th><th class="cs-right-al">All trades together</th></tr>
        </thead>
        <tbody>
          <tr>
            <td>Stocks with a profit</td>
            <td class="cs-num" colspan="2">{share(props.summary!.profitable)} of {props.summary!.stocks} that traded</td>
          </tr>
          <For each={rows()}>
            {(m) => (
              <tr>
                <td>{m.label}</td>
                <td class="cs-num" style={m.colored ? { color: tone(props.summary!.median[m.id] as number) } : undefined}>{m.fmt(props.summary!.median)}</td>
                <td class="cs-num" style={m.colored ? { color: tone(props.summary!.pooled![m.id] as number) } : undefined}>{m.fmt(props.summary!.pooled!)}</td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </Show>
  );
}

/** The period pills: the whole run, in- and out-of-sample, each year; and the chosen one's dates. */
function PeriodPicker(props: { backtest: Backtest; value: string; onChange: (id: string) => void }) {
  const p = () => props.backtest.periods.find((x) => x.id === props.value) ?? props.backtest.periods[0];
  return (
    <div class="cs-bt-period">
      <Pills items={props.backtest.periods.map((x) => ({ id: x.id, label: x.label }))} value={props.value} onChange={props.onChange} label="Period" />
      <span class="cs-fog">{span(p())}</span>
    </div>
  );
}

// ── Stocks ──────────────────────────────────────────────────────────────

const BROWSER: Metric["id"][] = ["trades", "win_rate", "profit_factor", "avg_trade", "avg_win", "avg_loss", "largest_loss", "avg_days"];
const SHORT_LABEL: Partial<Record<Metric["id"], string>> = { profit_factor: "Profit factor", avg_trade: "Avg trade", avg_win: "Avg win", avg_loss: "Avg loss", avg_days: "Days in trade" };
const PAGE = 25;

/** Every stock with the chosen setting and period: search, sort, open one. */
function StockBrowser(props: { post: Post; setting: Setting; onSetting: (s: Setting) => void; period: string; onPeriod: (id: string) => void; open: string | null; onOpen: (symbol: string | null) => void }) {
  const b = () => props.post.backtest!;
  const [rows] = createResource(() => props.post.id, (id) => api.backtestFile<BacktestStockRow[]>(id, "stocks.json", b().files_version));
  const [query, setQuery] = createSignal("");
  const [sort, setSort] = createSignal<{ key: "symbol" | Metric["id"]; desc: boolean }>({ key: "avg_trade", desc: true });
  const [shown, setShown] = createSignal(PAGE);
  const columns = () => METRICS.filter((m) => BROWSER.includes(m.id) || (m.account && !fixedSize(b())));
  const list = createMemo(() => {
    const q = query().trim().toUpperCase();
    const all = (rows() ?? []).filter((r) => !q || r.symbol.includes(q) || r.name.toUpperCase().includes(q));
    const { key, desc } = sort();
    const val = (r: BacktestStockRow) => (key === "symbol" ? r.symbol : ((r[props.setting][props.period]?.[key] as number | undefined) ?? null));
    return all.sort((x, y) => {
      const a = val(x);
      const c = val(y);
      // Stocks without a trade in the period go last, whatever the order.
      if (a == null || c == null) return a == null ? (c == null ? 0 : 1) : -1;
      const d = typeof a === "string" ? a.localeCompare(c as string) : a - (c as number);
      return desc ? -d : d;
    });
  });
  const pick = (key: "symbol" | Metric["id"]) => setSort((s) => ({ key, desc: s.key === key ? !s.desc : key !== "symbol" }));
  const head = (key: "symbol" | Metric["id"], label: string, num: boolean) => (
    <th class={num ? "cs-right-al" : ""} aria-sort={sort().key === key ? (sort().desc ? "descending" : "ascending") : undefined}>
      <button type="button" class="cs-bt-sort" onClick={() => pick(key)}>{label}{sort().key === key ? (sort().desc ? " ↓" : " ↑") : ""}</button>
    </th>
  );
  return (
    <div class="cs-bt-browser">
      <div class="cs-bt-controls">
        <Pills items={[{ id: "default" as Setting, label: "Author's settings" }, { id: "optimized" as Setting, label: "Optimized setting" }]} value={props.setting} onChange={props.onSetting} label="Settings" />
        <input class="cs-input cs-bt-search" type="search" placeholder={`Search ${b().universe.count} stocks`} aria-label="Search stocks" value={query()} onInput={(e) => { setQuery(e.currentTarget.value); setShown(PAGE); }} />
      </div>
      <PeriodPicker backtest={b()} value={props.period} onChange={props.onPeriod} />
      <div class="cs-note">{settingLine(b(), props.setting)}. Click a stock for its chart, trades and metrics.</div>
      <Show when={!rows.error} fallback={<p class="cs-error">{errorText(rows.error)}</p>}>
        <Show when={rows()} fallback={<p class="cs-loading">Loading the stocks…</p>}>
          <div class="cs-bt-scroll">
            <table class="cs-table cs-bt-stocks">
              <thead>
                <tr>
                  {head("symbol", "Stock", false)}
                  <For each={columns()}>{(m) => head(m.id, SHORT_LABEL[m.id] ?? m.label, true)}</For>
                </tr>
              </thead>
              <tbody>
                <For each={list().slice(0, shown())}>
                  {(r) => {
                    const s = () => r[props.setting][props.period];
                    return (
                      <tr class={"is-link" + (props.open === r.symbol ? " is-open" : "")} onClick={() => props.onOpen(props.open === r.symbol ? null : r.symbol)}>
                        <td><strong data-no-translate>{r.symbol}</strong> <span class="cs-fog cs-bt-name" data-no-translate>{r.name}</span></td>
                        <For each={columns()}>
                          {(m) => <td class="cs-num" style={m.colored ? { color: tone(s()?.[m.id] as number) } : undefined}>{s() ? m.fmt(s()!) : "—"}</td>}
                        </For>
                      </tr>
                    );
                  }}
                </For>
              </tbody>
            </table>
          </div>
          <Show when={list().length > shown()}>
            <button type="button" class="cs-more" onClick={() => setShown((n) => n + PAGE * 2)}>Show more ({list().length - shown()} left)</button>
          </Show>
          <Show when={!list().length}><p class="cs-note">No stock matches.</p></Show>
        </Show>
      </Show>
    </div>
  );
}

/** The stock's bars with the trades of one setting: entries as arrows, exits as dots. */
function TradesChart(props: { stock: BacktestStock; setting: Setting; focus: BacktestTrade | null }) {
  let el!: HTMLDivElement;
  let chart: IChartApi | null = null;
  let series: ISeriesApi<"Candlestick"> | null = null;
  let markers: { setMarkers(m: SeriesMarker<Time>[]): void } | null = null;
  const [ready, setReady] = createSignal(false);
  onMount(async () => {
    // The chart library loads with the first chart, not with the site.
    const lc = await import("lightweight-charts");
    if (!el.isConnected) return;
    chart = lc.createChart(el, {
      autoSize: true,
      layout: { background: { type: lc.ColorType.Solid, color: "#0f0f0f" }, textColor: FOG, fontFamily: "Inter, -apple-system, Segoe UI, sans-serif", fontSize: 11, attributionLogo: false },
      grid: { vertLines: { visible: false }, horzLines: { color: "#1e2026" } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: true },
      crosshair: { horzLine: { labelBackgroundColor: "#2a2c33" }, vertLine: { labelBackgroundColor: "#2a2c33" } },
      localization: { locale: "en-GB", dateFormat: "dd/MM/yyyy" },
    });
    series = chart.addSeries(lc.CandlestickSeries, { upColor: UP, downColor: DOWN, wickUpColor: UP, wickDownColor: DOWN, borderVisible: false, priceLineVisible: false });
    markers = lc.createSeriesMarkers(series, []);
    setReady(true);
  });
  onCleanup(() => chart?.remove());
  createEffect(() => {
    if (!ready() || !series || !chart) return;
    const b = props.stock.bars;
    series.setData(b.t.map((t, i) => ({ time: nyChartTime(t), open: b.o[i], high: b.h[i], low: b.l[i], close: b.c[i] })));
    const m: SeriesMarker<Time>[] = [];
    for (const t of props.stock[props.setting].trades) {
      const long = t.side === "long";
      m.push({ time: nyChartTime(t.entry_time), position: long ? "belowBar" : "aboveBar", shape: long ? "arrowUp" : "arrowDown", color: long ? UP : DOWN, text: long ? "Long" : "Short" });
      if (t.exit_time != null) m.push({ time: nyChartTime(t.exit_time), position: long ? "aboveBar" : "belowBar", shape: "circle", color: FOG, text: signed(t.ret, 1) });
    }
    markers!.setMarkers(m.sort((a, c) => (a.time as number) - (c.time as number)));
    chart.timeScale().fitContent();
  });
  // A trade picked in the list: the chart shows it with some bars around.
  createEffect(() => {
    const t = props.focus;
    if (!ready() || !chart || !t) return;
    const bars = props.stock.bars.t;
    const i = bars.findIndex((x) => x >= t.entry_time);
    const j = t.exit_time == null ? bars.length - 1 : bars.findIndex((x) => x >= t.exit_time!);
    const pad = Math.max(20, Math.round((j - i) * 0.5));
    chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, i - pad), to: Math.min(bars.length - 1, j + pad) });
  });
  return <div class="cs-bt-chart" ref={el} />;
}

/** One stock: chart, metrics of every period (the chosen one marked), trades; open it in the app. */
function StockDetail(props: { post: Post; symbol: string; setting: Setting; period: string; onClose: () => void }) {
  const [stock] = createResource(() => [props.post.id, props.symbol] as const, ([id, s]) => api.backtestFile<BacktestStock>(id, `s/${s}.json`, props.post.backtest!.files_version));
  const [focus, setFocus] = createSignal<BacktestTrade | null>(null);
  const b = () => props.post.backtest!;
  // The app adds its port of the script with this setting's inputs (by title) to a new tab on the stock.
  const appLink = () => {
    const inputs = Object.fromEntries(b().inputs.map((i) => [i.title, props.setting === "default" ? i.default : i.optimized]));
    const q = new URLSearchParams({ symbol: props.symbol, interval: b().interval, study: b().app_study!, inputs: JSON.stringify(inputs) });
    return `opentrader://chart?${q}`;
  };
  return (
    <div class="cs-bt-detail" id="cs-bt-detail">
      <div class="cs-bt-detail-head">
        <div>
          <strong class="cs-bt-sym" data-no-translate>{props.symbol}</strong>
          <Show when={stock()}><span class="cs-fog" data-no-translate> {stock()!.name}</span></Show>
          <span class="cs-fog"> · {tfLong(b().interval)} · {props.setting === "default" ? "author's settings" : "optimized setting"}</span>
        </div>
        <div class="cs-row">
          <Show when={b().app_study}>
            <a class="cs-btn" href={appLink()} title="Opens the stock in the OpenTrader app with the strategy and its Strategy Tester">Open in OpenTrader</a>
          </Show>
          <button type="button" class="cs-btn" onClick={() => props.onClose()}>Close</button>
        </div>
      </div>
      <Show when={!stock.error} fallback={<p class="cs-error">{errorText(stock.error)}</p>}>
        <Show when={stock()} fallback={<p class="cs-loading">Loading the chart…</p>}>
          {(s) => {
            const run = () => s()[props.setting];
            return (
              <>
                <TradesChart stock={s()} setting={props.setting} focus={focus()} />
                <div class="cs-note">
                  Times in New York. In-sample to {nyDay(s().split)}, out-of-sample after. Arrows: entries; dots: exits with the trade's return.
                </div>
                <h4 class="cs-bt-h4">Metrics</h4>
                <div class="cs-bt-scroll">
                  <table class="cs-table cs-bt-periods">
                    <thead>
                      <tr><th /><For each={b().periods}>{(p) => <th class={"cs-right-al" + (p.id === props.period ? " is-on" : "")}>{p.label}</th>}</For></tr>
                    </thead>
                    <tbody>
                      <For each={metricsOf(b())}>
                        {(m) => (
                          <tr>
                            <td>{m.label}</td>
                            <For each={b().periods}>
                              {(p) => {
                                const v = () => run().metrics[p.id];
                                return <td class={"cs-num" + (p.id === props.period ? " is-on" : "")} style={m.colored && v() ? { color: tone(v()![m.id] as number) } : undefined}>{v() ? m.fmt(v()!) : "—"}</td>;
                              }}
                            </For>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </div>
                <h4 class="cs-bt-h4">Trades ({run().trades.length})</h4>
                <div class="cs-bt-scroll is-trades">
                  <table class="cs-table cs-bt-trades">
                    <thead>
                      <tr><th>#</th><th>Side</th><th>Entry</th><th class="cs-right-al">Price</th><th>Exit</th><th class="cs-right-al">Price</th><th class="cs-right-al">Days</th><th class="cs-right-al">Return</th></tr>
                    </thead>
                    <tbody>
                      <For each={run().trades}>
                        {(t, i) => (
                          <tr class={"is-link" + (focus() === t ? " is-open" : "")} onClick={() => setFocus(t)} title="Show on the chart">
                            <td class="cs-fog">{i() + 1}</td>
                            <td style={{ color: t.side === "long" ? UP : DOWN }}>{t.side === "long" ? "Long" : "Short"}</td>
                            <td>{nyParts(t.entry_time).text}</td>
                            <td class="cs-num">{t.entry_price.toFixed(2)}</td>
                            <td>{t.exit_time == null ? <span class="cs-fog">open at the end</span> : nyParts(t.exit_time).text}</td>
                            <td class="cs-num">{t.exit_price == null ? "—" : t.exit_price.toFixed(2)}</td>
                            <td class="cs-num">{t.exit_time == null ? "—" : Math.round((t.exit_time - t.entry_time) / 86400)}</td>
                            <td class="cs-num" style={{ color: tone(t.ret) }}>{signed(t.ret)}</td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </div>
              </>
            );
          }}
        </Show>
      </Show>
    </div>
  );
}

// ── The post ────────────────────────────────────────────────────────────

/** The post's content: rules, data, results and the stock browser, the optimized setting. */
export function BacktestBody(props: { post: Post }) {
  const b = () => props.post.backtest!;
  const [setting, setSetting] = createSignal<Setting>("default");
  const [period, setPeriod] = createSignal("out");
  const [open, setOpen] = createSignal<string | null>(null);
  const periodOf = (id: string): BacktestPeriod => b().periods.find((p) => p.id === id) ?? b().periods[0];
  const browse = (s: Setting) => {
    setSetting(s);
    document.getElementById("cs-bt-stocks")?.scrollIntoView({ behavior: "smooth" });
  };
  const costs = () => {
    const c = b().costs;
    const fees = c.commission === 0 && c.slippage === 0 ? "no commission, no slippage" : `commission ${c.commission}, slippage ${c.slippage}`;
    return `${c.capital.toLocaleString("en-US")} starting capital, ${c.order} per order, ${fees} (the script's own settings)`;
  };
  return (
    <div class="cs-bt">
      <section>
        <h3 class="cs-bt-h3">Rules</h3>
        <RulesCode text={b().rules} />
      </section>

      <section>
        <h3 class="cs-bt-h3">Data</h3>
        <dl class="cs-bt-facts">
          <dt>Timeframe</dt><dd>{tfLong(b().interval)} bars, regular session, split-adjusted</dd>
          <dt>Period</dt><dd>{span(periodOf("full"))}</dd>
          <dt>In-sample</dt><dd>{span(periodOf("in"))}</dd>
          <dt>Out-of-sample</dt><dd>{span(periodOf("out"))}. A stock listed later splits at 60% of its own history.</dd>
          <dt>Stocks</dt><dd>{b().universe.label}: {b().universe.rule} <a href="#cs-bt-stocks" onClick={(e) => { e.preventDefault(); browse(setting()); }}>See the list</a></dd>
          <dt>Costs</dt><dd>{costs()}</dd>
        </dl>
      </section>

      <section id="cs-bt-results">
        <h3 class="cs-bt-h3">Results with the author's settings</h3>
        <div class="cs-note">{settingLine(b(), "default")}</div>
        <PeriodPicker backtest={b()} value={period()} onChange={setPeriod} />
        <SummaryTable backtest={b()} summary={b().summary.default[period()]} />
        <div class="cs-note">
          A trade counts in the period its exit falls in. Profit factor: gross profit over gross loss in dollars, so with {b().costs.order} per order the
          higher-priced stocks weigh more; returns are per trade.
        </div>
        <h4 class="cs-bt-h4" id="cs-bt-stocks">By stock</h4>
        <StockBrowser post={props.post} setting={setting()} onSetting={setSetting} period={period()} onPeriod={setPeriod} open={open()}
          onOpen={(s) => { setOpen(s); if (s) requestAnimationFrame(() => document.getElementById("cs-bt-detail")?.scrollIntoView({ behavior: "smooth", block: "start" })); }} />
        <Show when={open()}>{(s) => <StockDetail post={props.post} symbol={s()} setting={setting()} period={period()} onClose={() => setOpen(null)} />}</Show>
      </section>

      <section>
        <h3 class="cs-bt-h3">Optimized setting</h3>
        <table class="cs-table cs-bt-inputs">
          <thead><tr><th>Input</th><th class="cs-right-al">Author's</th><th class="cs-right-al">Optimized</th><th class="cs-right-al">Range searched</th></tr></thead>
          <tbody>
            <For each={b().inputs}>
              {(i) => (
                <tr>
                  <td>{i.title}</td>
                  <td class="cs-num">{i.default}</td>
                  <td class="cs-num cs-strong">{i.optimized}</td>
                  <td class="cs-num">{i.from} to {i.to}, step {i.step}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
        <div class="cs-note">{b().selection} The out-of-sample results are what that choice gave on data it had not seen.</div>
        <PeriodPicker backtest={b()} value={period()} onChange={setPeriod} />
        <SummaryTable backtest={b()} summary={b().summary.optimized[period()]} />
        <button type="button" class="cs-btn" onClick={() => browse("optimized")}>Browse the stocks with the optimized setting</button>
      </section>

      <p class="cs-note cs-bt-caveat">A backtest is not a forecast. Many settings were tried, so some look good by chance; the out-of-sample figures reduce that risk without removing it.</p>
    </div>
  );
}

/** The Backtests page: every backtest, newest first. */
export function BacktestsPage() {
  createEffect(() => { document.title = "Backtests · OpenTrader Community"; });
  const [posts] = createResource(() => api.posts(BACKTESTS, "new", 0).then((r) => r.posts));
  return (
    <>
      <div class="cs-tickerhead">
        <div>
          <h1 class="cs-tk is-big">Backtests</h1>
          <div class="cs-fog">Public strategy scripts run on hundreds of US stocks: their rules, every trade, and how they did on data they had not seen.</div>
        </div>
      </div>
      <div>
        <main id="cs-main" class="cs-center is-wide cs-bt-list">
          <Show when={!posts.error} fallback={<p class="cs-error">{errorText(posts.error)}</p>}>
            <Show when={posts()} fallback={<p class="cs-loading">Loading…</p>}>
              <table class="cs-table">
                <thead>
                  <tr><th>Strategy</th><th>Timeframe</th><th class="cs-right-al">Stocks</th><th class="cs-right-al">Avg trade, out-of-sample</th><th class="cs-right-al">With a profit</th><th class="cs-right-al">Posted</th></tr>
                </thead>
                <tbody>
                  <For each={posts()!} fallback={<tr><td colspan="6" class="cs-fog">No backtest yet.</td></tr>}>
                    {(p) => {
                      const out = () => p.backtest?.summary.default.out;
                      return (
                        <tr class="is-link" onClick={go(`/p/${p.id}`)}>
                          <td><a href={`/p/${p.id}`} onClick={go(`/p/${p.id}`)} data-no-translate>{p.title}</a> <span class="cs-fog">by <span data-no-translate>{p.backtest?.strategy.author}</span></span></td>
                          <td>{p.backtest ? tfLong(p.backtest.interval) : "—"}</td>
                          <td class="cs-num">{p.backtest?.universe.count ?? "—"}</td>
                          <td class="cs-num" style={{ color: tone(out()?.median.avg_trade) }}>{signed(out()?.median.avg_trade)}</td>
                          <td class="cs-num">{share(out()?.profitable)}</td>
                          <td class="cs-num cs-fog">{age(p.created_at)} ago</td>
                        </tr>
                      );
                    }}
                  </For>
                </tbody>
              </table>
              <p class="cs-note">Median stock with the script author's settings. Posted by <UserLink name={posts()![0]?.author ?? null} />; open one for its rules, trades and charts.</p>
            </Show>
          </Show>
        </main>
      </div>
    </>
  );
}
