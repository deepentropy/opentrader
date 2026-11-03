/*
 * Script screener scan: one indicator of the Indicators dialog run over every
 * symbol of a list, on daily, weekly or monthly bars, read on the newest bar
 * (./script-screen).
 *
 * Bars and gateway load: the daily history comes from the same command as
 * the charts (disk cache of the closed sessions, memoised for the day), so a
 * symbol costs at most one history load a day; the session in progress comes
 * from the screener's live table (one scan for the whole list), not from a
 * request per symbol. Weekly and monthly bars are built from the daily ones.
 * History loads run a few at a time.
 */
import type { Bar } from "oakscriptjs";
import { MissingSymbolDataError } from "oakscriptjs/script";
import { commands } from "../bindings";
import { isAdjusted } from "./datafeed";
import { symbolSessions } from "./session";
import { screenerScan } from "./screener-api";
import { aggregateCandles, type AggregatePeriod } from "../window/chart/chart-aggregate";
import { scriptChartContext } from "../window/chart/indicators/script-chart";
import { OtherSymbolBars } from "../window/chart/indicators/other-symbols";
import { scriptBars } from "../backtester/oakscript";
import type { IndicatorRegistryEntry } from "lightweight-charts-indicators";
import { bareTicker, readRun, withSession, type ScriptInterval, type ScriptRow, type SessionBar } from "./script-screen";

/** Trading days of daily history per interval: ~3 years of daily bars, ~5 years of weekly and monthly ones (within
 *  the recent history window, so no archive download). */
const HISTORY_DAYS: Record<ScriptInterval, number> = { "1D": 750, "1W": 1250, "1M": 1250 };
const AGGREGATE: Record<ScriptInterval, AggregatePeriod | null> = {
  "1D": null,
  "1W": { unit: "week", n: 1 },
  "1M": { unit: "month", n: 1 },
};
/** History loads in flight at once. */
const CONCURRENCY = 6;

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

/** Run the indicator over every symbol. Resolves when every row is done (or the scan is no longer wanted). */
export async function runScriptScan(spec: ScanSpec, ev: ScanEvents): Promise<void> {
  const live = await sessionBars(spec.symbols).catch(() => new Map<string, SessionBar>());
  const marks = new Map<string, string>();
  // Bars of other symbols (request.security of another ticker, e.g. a relative strength against an index): loaded
  // once for the whole scan; a run that needs bars not loaded yet waits for them.
  let arrived: (() => void) | null = null;
  const others = new OtherSymbolBars(() => arrived?.(), "script-screener");
  const queue = [...spec.symbols];
  const worker = async () => {
    for (let symbol = queue.shift(); symbol !== undefined && ev.wanted(); symbol = queue.shift()) {
      const row = await scanSymbol(symbol, spec, live, others, (wait) => (arrived = wait), marks, ev);
      if (ev.wanted()) ev.onRow(row);
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
  } finally {
    others.dispose();
  }
}

async function scanSymbol(
  symbol: string,
  spec: ScanSpec,
  live: Map<string, SessionBar>,
  others: OtherSymbolBars,
  onArrive: (wait: () => void) => void,
  marks: Map<string, string>,
  ev: ScanEvents,
): Promise<ScriptRow> {
  try {
    const [history, sessions] = await Promise.all([
      commands.getDailyHistory(symbol, HISTORY_DAYS[spec.interval], isAdjusted()),
      symbolSessions(symbol),
    ]);
    if (history.status === "error") throw new Error(history.error);
    const daily = withSession(history.data.bars, live.get(bareTicker(symbol)));
    const agg = AGGREGATE[spec.interval];
    const candles = agg ? aggregateCandles(daily, agg, sessions.regular) : daily;
    if (!candles.length) return { symbol, cells: {}, error: "No data" };
    const chart = {
      ...scriptChartContext(symbol, spec.interval, "RTH"),
      realtime: false,
      lastBarConfirmed: true,
      lastBarNew: true,
      bars: (s: string, tf: string) => others.bars(s, tf, spec.interval),
      symbolInfo: (s: string) => others.symbolInfo(s),
      chartId: "script-screener",
      studyId: symbol,
    };
    const dense: Bar[] = candles.map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume ?? 0 }) as Bar);
    const given = scriptBars(dense, chart);
    const calculate = spec.entry.calculate as (bars: Bar[], inputs: unknown, chart: unknown) => unknown;
    let result: unknown;
    for (let attempt = 0; ; attempt++) {
      try {
        result = calculate(given, structuredClone(spec.inputs), chart);
        break;
      } catch (e) {
        // Bars of another symbol are loading: wait for them (a few times), then run again.
        if (!(e instanceof MissingSymbolDataError) || attempt >= 3 || !ev.wanted()) throw e;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 15_000);
          onArrive(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    }
    const before = marks.size;
    const cells = readRun(spec.entry, result, given, dense.map((b) => b.time as number), spec.inputs, marks);
    if (marks.size > before) for (const [k, t] of marks) ev.onMark(k, t);
    return { symbol, cells };
  } catch (e) {
    return { symbol, cells: {}, error: e instanceof Error ? e.message : String(e) };
  }
}
