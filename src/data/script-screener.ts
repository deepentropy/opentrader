/*
 * Script screener scan: one indicator of the Indicators dialog (a built-in or
 * the user's own OakScript) run over every symbol of a list, read on the
 * newest bar (./script-screen).
 *
 * Bars and gateway load:
 *  - daily, weekly, monthly: the daily history comes from the same command
 *    as the charts (disk cache of the closed sessions, memoised for the
 *    day), so a symbol costs at most one history load a day; the session in
 *    progress comes from the screener's live table (one scan for the whole
 *    list), not from a request per symbol. Weekly and monthly bars are built
 *    from the daily ones.
 *  - intraday: the chart's minute history (closed sessions from the disk
 *    cache), one request per symbol and scan for the session in progress;
 *    the screen caps the list (INTRADAY_MAX_SYMBOLS) and fewer loads run at
 *    once.
 * The indicator gets the newest MAX_BARS bars of the regular session; with
 * "Wait for timeframe closes" a bar still forming is left out.
 */
import type { Bar } from "oakscriptjs";
import { MissingSymbolDataError } from "oakscriptjs/script";
import type { IndicatorRegistryEntry } from "lightweight-charts-indicators";
import { commands, type Candle } from "../bindings";
import { getBars, isAdjusted } from "./datafeed";
import { symbolSessions } from "./session";
import { screenerScan } from "./screener-api";
import * as scripts from "./oakscript-store";
import { aggregateCandles, periodStart, type AggregatePeriod } from "../window/chart/chart-aggregate";
import { scriptChartContext } from "../window/chart/indicators/script-chart";
import { OtherSymbolBars } from "../window/chart/indicators/other-symbols";
import { USER_INDICATOR_PREFIX, isUserIndicatorId } from "../window/chart/indicators/user-scripts";
import { getOakEngine, OakEngineError } from "../window/oakscript/engine";
import { scriptBars, type OtherSymbolData } from "../backtester/oakscript";
import { localDay } from "./session/zone";
import {
  MAX_BARS,
  bareTicker,
  intradayMinutes,
  readRun,
  withSession,
  type ScriptInterval,
  type ScriptRow,
  type SessionBar,
} from "./script-screen";

/** Trading days of daily history per interval: ~3 years of daily bars, ~5 years of weekly and monthly ones (within
 *  the recent history window, so no archive download). */
const HISTORY_DAYS = { "1D": 750, "1W": 1250, "1M": 1250 } as const;
const AGGREGATE: Record<"1D" | "1W" | "1M", AggregatePeriod | null> = {
  "1D": null,
  "1W": { unit: "week", n: 1 },
  "1M": { unit: "month", n: 1 },
};
/** History loads in flight at once (daily family / intraday). */
const CONCURRENCY = 6;
const INTRADAY_CONCURRENCY = 3;
/** Market data comes 15 minutes late (the "Delayed 15 min" badge): a bar ending after that is still forming. */
const DATA_DELAY_SEC = 15 * 60;

/** Tickers of an index (its code in the live table: "SPX"...), by name. */
export async function indexTickers(code: string): Promise<string[]> {
  const res = await screenerScan({
    columns: [],
    filter: [{ left: "indexes", operation: "in_range", right: [code] }],
    sort: { sortBy: "name", sortOrder: "asc" },
    range: [0, 10_000],
    tickers: null,
  });
  return res.rows.map((r) => r.s);
}

/** Company names of tickers, from the live table's reference list. */
export async function tickerNames(symbols: string[]): Promise<Map<string, string>> {
  const tickers = [...new Set(symbols.map(bareTicker))];
  const out = new Map<string, string>();
  if (!tickers.length) return out;
  const res = await screenerScan({ columns: ["description"], filter: [], sort: null, range: [0, tickers.length], tickers });
  for (const r of res.rows) if (typeof r.d[0] === "string") out.set(r.s, r.d[0]);
  return out;
}

/** The live session of every ticker of the list: one scan of the screener's table. */
async function sessionBars(symbols: string[]): Promise<Map<string, SessionBar>> {
  const tickers = [...new Set(symbols.map(bareTicker))];
  const out = new Map<string, SessionBar>();
  if (!tickers.length) return out;
  const res = await screenerScan({
    columns: ["open", "high", "low", "close", "volume", "session_day"],
    filter: [],
    sort: null,
    range: [0, tickers.length],
    tickers,
  });
  for (const r of res.rows) {
    const [open, high, low, close, volume, time] = r.d.map((c) => (typeof c === "number" ? c : null));
    if (time == null || open == null || close == null) continue;
    out.set(r.s, { time, open, high: high ?? Math.max(open, close), low: low ?? Math.min(open, close), close, volume: volume ?? 0 });
  }
  return out;
}

export type ScanSpec = {
  entry: IndicatorRegistryEntry;
  inputs: Record<string, unknown>;
  interval: ScriptInterval;
  /** Leave out a newest bar that is still forming ("Wait for timeframe closes"). */
  closedOnly?: boolean;
  symbols: string[];
};

export type ScanEvents = {
  /** A symbol is done (its row, or its error). */
  onRow: (row: ScriptRow) => void;
  /** A new kind of mark was met (a column to add). */
  onMark: (key: string, title: string) => void;
  /** False once the scan is no longer wanted: the rest is skipped. */
  wanted: () => boolean;
};

/** Waiters for bars of other symbols: every run waiting is woken when some arrive. */
class Arrivals {
  private waiters = new Set<() => void>();
  notify = (): void => {
    const w = [...this.waiters];
    this.waiters.clear();
    for (const f of w) f();
  };
  wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.waiters.add(done);
    });
  }
}

/** Run the indicator over every symbol. Resolves when every row is done (or the scan is no longer wanted). */
export async function runScriptScan(spec: ScanSpec, ev: ScanEvents): Promise<void> {
  const intraday = intradayMinutes(spec.interval) !== null;
  const live = intraday ? new Map<string, SessionBar>() : await sessionBars(spec.symbols).catch(() => new Map<string, SessionBar>());
  const marks = new Map<string, string>();
  // Bars of other symbols (request.security of another ticker, e.g. a relative strength against an index): loaded
  // once for the whole scan; a run that needs bars not loaded yet waits for them.
  const arrivals = new Arrivals();
  const others = new OtherSymbolBars(arrivals.notify, "script-screener");
  // A user script runs in the script worker: compiled once for the scan.
  let compiled: Promise<void> | null = null;
  if (isUserIndicatorId(spec.entry.id)) {
    const scriptId = spec.entry.id.slice(USER_INDICATOR_PREFIX.length);
    const script = scripts.loadScript(scriptId);
    compiled = script ? getOakEngine().compile(scriptId, script.source).then(() => undefined) : Promise.reject(new Error("Script no longer exists."));
    compiled.catch(() => undefined);
  }
  const queue = [...spec.symbols];
  const worker = async () => {
    for (let symbol = queue.shift(); symbol !== undefined && ev.wanted(); symbol = queue.shift()) {
      const row = await scanSymbol(symbol, spec, live, others, arrivals, compiled, marks, ev);
      if (ev.wanted()) ev.onRow(row);
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(intraday ? INTRADAY_CONCURRENCY : CONCURRENCY, queue.length) }, worker));
  } finally {
    others.dispose();
  }
}

/** Bars of a symbol on the interval, regular session, oldest first; `forming`: the newest one is not closed yet. */
async function symbolBars(symbol: string, spec: ScanSpec, live: Map<string, SessionBar>): Promise<{ candles: Candle[]; forming: boolean }> {
  const now = Date.now() / 1000 - DATA_DELAY_SEC;
  const mins = intradayMinutes(spec.interval);
  if (mins !== null) {
    const { bars } = await getBars(symbol, spec.interval, "RTH");
    const last = bars[bars.length - 1];
    return { candles: bars, forming: !!last && (last.time as number) + mins * 60 > now };
  }
  const iv = spec.interval as "1D" | "1W" | "1M";
  const [history, sessions] = await Promise.all([commands.getDailyHistory(symbol, HISTORY_DAYS[iv], isAdjusted()), symbolSessions(symbol)]);
  if (history.status === "error") throw new Error(history.error);
  const daily = withSession(history.data.bars, live.get(bareTicker(symbol)));
  const regular = sessions.regular;
  const lastDay = daily[daily.length - 1];
  const dayEnd = lastDay ? regular.dayBounds(localDay(regular.timeZone, lastDay.time as number))?.end ?? null : null;
  const dayForming = dayEnd !== null && dayEnd > now;
  const agg = AGGREGATE[iv];
  if (!agg) return { candles: daily, forming: dayForming };
  const candles = aggregateCandles(daily, agg, regular);
  const last = candles[candles.length - 1];
  // A week or a month is forming while it is the current one, or while its last day still trades.
  return { candles, forming: !!last && (dayForming || periodStart(now, agg, regular) === last.time) };
}

async function scanSymbol(
  symbol: string,
  spec: ScanSpec,
  live: Map<string, SessionBar>,
  others: OtherSymbolBars,
  arrivals: Arrivals,
  compiled: Promise<void> | null,
  marks: Map<string, string>,
  ev: ScanEvents,
): Promise<ScriptRow> {
  try {
    const { candles, forming } = await symbolBars(symbol, spec, live);
    const kept = spec.closedOnly && forming ? candles.slice(0, -1) : candles;
    const recent = kept.slice(-MAX_BARS);
    if (!recent.length) return { symbol, cells: {}, error: "No data" };
    const context = {
      ...scriptChartContext(symbol, spec.interval, "RTH"),
      realtime: false,
      lastBarConfirmed: true,
      lastBarNew: true,
    };
    const dense: Bar[] = recent.map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume ?? 0 }) as Bar);
    const given = scriptBars(dense, context);
    const result = compiled
      ? await runUserScript(spec, symbol, given, context, others, arrivals, compiled, ev)
      : await runBuiltIn(spec, given, context, others, arrivals, ev);
    const before = marks.size;
    const cells = readRun(spec.entry, result, given, dense.map((b) => b.time as number), spec.inputs, marks);
    if (marks.size > before) for (const [k, t] of marks) ev.onMark(k, t);
    return { symbol, cells };
  } catch (e) {
    return { symbol, cells: {}, error: e instanceof Error ? e.message : String(e) };
  }
}

/** A built-in: calculated here; a run that needs bars of another symbol not loaded yet waits for them (a few times). */
async function runBuiltIn(spec: ScanSpec, given: Bar[], context: object, others: OtherSymbolBars, arrivals: Arrivals, ev: ScanEvents): Promise<unknown> {
  const chart = {
    ...context,
    bars: (s: string, tf: string) => others.bars(s, tf, spec.interval),
    symbolInfo: (s: string) => others.symbolInfo(s),
    chartId: "script-screener",
  };
  const calculate = spec.entry.calculate as (bars: Bar[], inputs: unknown, chart: unknown) => unknown;
  for (let attempt = 0; ; attempt++) {
    try {
      return calculate(given, structuredClone(spec.inputs), chart);
    } catch (e) {
      if (!(e instanceof MissingSymbolDataError) || attempt >= 3 || !ev.wanted()) throw e;
      await arrivals.wait(15_000);
    }
  }
}

/** A user script: run in the script worker; the bars of the other symbols it asks for go with the next run. */
async function runUserScript(
  spec: ScanSpec,
  symbol: string,
  given: Bar[],
  context: object,
  others: OtherSymbolBars,
  arrivals: Arrivals,
  compiled: Promise<void>,
  ev: ScanEvents,
): Promise<unknown> {
  await compiled;
  const scriptId = spec.entry.id.slice(USER_INDICATOR_PREFIX.length);
  const symbols: OtherSymbolData = { bars: {}, info: {} };
  for (let attempt = 0; ; attempt++) {
    try {
      return await getOakEngine().run(scriptId, given, structuredClone(spec.inputs), { ...context, studyId: symbol } as never, symbols);
    } catch (e) {
      const missing = e instanceof OakEngineError ? e.detail.missing : undefined;
      if (!missing?.length || attempt >= 3 || !ev.wanted()) throw e;
      for (const m of missing) {
        let bars = others.bars(m.symbol, m.timeframe, spec.interval);
        if (!bars) {
          await arrivals.wait(15_000);
          bars = others.bars(m.symbol, m.timeframe, spec.interval);
        }
        symbols.bars[`${m.symbol}|${m.timeframe}`] = bars ?? [];
        const info = others.symbolInfo(m.symbol);
        if (info) symbols.info[m.symbol] = info;
      }
    }
  }
}
