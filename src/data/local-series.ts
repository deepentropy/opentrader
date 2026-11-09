/*
 * Imported bar series (#266): "LOCAL:<NAME>" symbols whose bars come from a
 * CSV file the user imported, not from the market-data server. The desktop app
 * keeps them in its data folder (`local_series_*` commands); the web version
 * keeps them for the browser session only (src/web/tauri-core.ts).
 *
 * The datafeed routes a local symbol here for its bars, session, reference
 * data and quote, so charts, studies, scripts, the strategy tester and bar
 * replay read it like any symbol, with no connection. A series has no live
 * data and serves the intervals at or above its file's bar size (a 5-minute
 * file: 5, 10, 15… minutes, and every daily interval, built from its bars).
 */
import { createSignal } from "solid-js";
import { listen, emit } from "@tauri-apps/api/event";
import { commands, type Candle, type LocalSeries, type LocalSource, type SymbolSession, type TickerInfo } from "../bindings";
import type { Snapshot } from "./datafeed-rest";
import { localDay, localToUtc } from "./session/zone";
import { parseBarsCsv, ROW, SERIES_NAME, type ParsedBars } from "./local-series-csv";
import { emitAppEvent } from "./app-events";
import { forgetSymbolSessions } from "./session/symbol-sessions";

export type { LocalSeries, LocalSource } from "../bindings";

/** Exchange part of an imported series' symbol. */
export const LOCAL_EXCHANGE = "LOCAL";

/** True for an imported series' symbol ("LOCAL:BTC_DEV"). */
export function isLocalSymbol(symbol: string | null | undefined): boolean {
  return !!symbol && /^LOCAL:/i.test(symbol.trim());
}

/** Symbol of a series name. */
export function localSymbol(name: string): string {
  return `${LOCAL_EXCHANGE}:${name}`;
}

function nameOf(symbol: string): string {
  return symbol.trim().replace(/^LOCAL:/i, "").toUpperCase();
}

const [list, setList] = createSignal<LocalSeries[]>([]);
let loaded: Promise<void> | null = null;
/** Bars of each series, read once per run. */
const barsCache = new Map<string, Promise<Candle[]>>();
/** Built daily bars of each intraday series. */
const dailyCache = new Map<string, Promise<Candle[]>>();

/** The imported series (reactive; loaded on first use). */
export function localSeriesList(): LocalSeries[] {
  void ensureLoaded();
  return list();
}

function ensureLoaded(): Promise<void> {
  loaded ??= reload();
  return loaded;
}

async function reload(): Promise<void> {
  const r = await commands.localSeriesList();
  if (r.status === "error") {
    loaded = null;
    throw new Error(r.error);
  }
  setList(r.data);
}

/** The description of a local symbol's series, when known (reactive). */
export function localSeriesMeta(symbol: string | null | undefined): LocalSeries | undefined {
  if (!isLocalSymbol(symbol)) return undefined;
  const name = nameOf(symbol!);
  return localSeriesList().find((s) => s.name === name);
}

async function metaOf(symbol: string): Promise<LocalSeries> {
  await ensureLoaded();
  const name = nameOf(symbol);
  const meta = list().find((s) => s.name === name);
  if (!meta) throw new Error(`No imported series named ${name}`);
  return meta;
}

/** Seconds of an interval id, or "daily" for the day / week / month family. */
function intervalSeconds(id: string): number | "daily" | null {
  if (/^[1-9]\d*[DWM]$/.test(id)) return "daily";
  let m = /^([1-9]\d*)S$/.exec(id);
  if (m) return Number(m[1]);
  m = /^([1-9]\d*)$/.exec(id);
  if (m) return Number(m[1]) * 60;
  return null;
}

/** Whether a local symbol has bars on `resolution`: every daily interval, and
 *  the intraday sizes that are a multiple of its file's bar size. Unknown
 *  series (not loaded yet): true, so a restored chart keeps its interval. */
export function localServesResolution(symbol: string, resolution: string): boolean {
  const res = intervalSeconds(resolution);
  if (res === null) return false;
  if (res === "daily") return true;
  const meta = localSeriesMeta(symbol);
  if (!meta) return true;
  const base = intervalSeconds(meta.base);
  return base !== "daily" && base !== null && res % base === 0;
}

/** Text of an interval a local symbol has no bars on. */
export function localIntervalMessage(symbol: string): string {
  const base = localSeriesMeta(symbol)?.base ?? "1D";
  return `Intervals less than ${base} are not supported for this symbol. Please change the interval to any available one.`;
}

function toCandles(rows: ArrayLike<number | null>): Candle[] {
  const out: Candle[] = new Array(Math.floor(rows.length / ROW));
  for (let i = 0, j = 0; j < out.length; i += ROW, j++) {
    out[j] = { time: rows[i], open: rows[i + 1], high: rows[i + 2], low: rows[i + 3], close: rows[i + 4], volume: rows[i + 5] };
  }
  return out;
}

/** The file's bars of a local symbol. */
export function localBaseBars(symbol: string): Promise<Candle[]> {
  const name = nameOf(symbol);
  let p = barsCache.get(name);
  if (!p) {
    p = metaOf(symbol).then(async () => {
      const r = await commands.localSeriesRead(name);
      if (r.status === "error") throw new Error(r.error);
      return toCandles(r.data);
    });
    p.catch(() => barsCache.delete(name));
    barsCache.set(name, p);
  }
  return p;
}

/** Bars of `step` seconds from finer time-ascending bars, each bucket
 *  starting at a multiple of `step` after its local midnight. */
function bucketBars(bars: Candle[], step: number, timeZone: string): Candle[] {
  const out: Candle[] = [];
  let cur: Candle | null = null;
  let curStart = NaN;
  for (const b of bars) {
    const t = b.time as number;
    const start =
      step >= 86400
        ? localToUtc(timeZone, localDay(timeZone, t), 0)
        : (() => {
            const midnight = localToUtc(timeZone, localDay(timeZone, t), 0);
            return midnight + Math.floor((t - midnight) / step) * step;
          })();
    if (start !== curStart) {
      if (cur) out.push(cur);
      cur = { ...b, time: start };
      curStart = start;
    } else if (cur) {
      cur.high = Math.max(cur.high as number, b.high as number);
      cur.low = Math.min(cur.low as number, b.low as number);
      cur.close = b.close;
      cur.volume = (cur.volume ?? 0) + (b.volume ?? 0);
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Daily bars of a local symbol: the file's, or built from its intraday bars
 *  (one per day in the series' time zone, stamped at its local midnight). */
export function localDailyBars(symbol: string): Promise<Candle[]> {
  const name = nameOf(symbol);
  let p = dailyCache.get(name);
  if (!p) {
    p = Promise.all([metaOf(symbol), localBaseBars(symbol)]).then(([meta, bars]) =>
      meta.base === "1D" ? bars : bucketBars(bars, 86400, meta.timezone),
    );
    p.catch(() => dailyCache.delete(name));
    dailyCache.set(name, p);
  }
  return p;
}

/** Intraday bars of a local symbol on `resolution` (seconds or minutes);
 *  empty when its file's bars are coarser. */
export async function localIntradayBars(symbol: string, resolution: string): Promise<Candle[]> {
  const meta = await metaOf(symbol);
  const res = intervalSeconds(resolution);
  const base = intervalSeconds(meta.base);
  if (typeof res !== "number" || typeof base !== "number" || res % base !== 0) return [];
  const bars = await localBaseBars(symbol);
  return res === base ? bars : bucketBars(bars, res, meta.timezone);
}

/** First index of time-ascending `bars` at or after `sec`. */
function lowerBound(bars: Candle[], sec: number): number {
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((bars[mid].time as number) < sec) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Bars of a local symbol before `beforeSec` over about `spanDays` trading
 *  days (raw daily bars for the daily family), for bar replay's windows; the
 *  chart itself loads the whole series at once. */
export async function localBarsBefore(symbol: string, resolution: string, beforeSec: number, spanDays: number): Promise<Candle[]> {
  const bars = intervalSeconds(resolution) === "daily" ? await localDailyBars(symbol) : await localIntradayBars(symbol, resolution);
  // Trading days to calendar days, with room for holidays.
  const from = beforeSec - Math.ceil((spanDays * 7) / 5 + 3) * 86400;
  return bars.slice(lowerBound(bars, from), lowerBound(bars, beforeSec));
}

/** A local series trades around the clock in its time zone (its bars are
 *  where it traded); its price grid is the file's. */
export async function localSession(symbol: string): Promise<SymbolSession> {
  const meta = await metaOf(symbol);
  return {
    timezone: meta.timezone,
    session: "24x7",
    subsessions: [{ id: "regular", description: "Regular Trading Hours", session: "24x7", corrections: "" }],
    holidays: "",
    corrections: "",
    pricescale: meta.pricescale,
    minmov: 1,
    variableTickSize: "",
  };
}

export async function localTickerInfo(symbol: string): Promise<TickerInfo> {
  const meta = await metaOf(symbol);
  return {
    ticker: meta.name,
    name: meta.description || meta.name,
    exchange: LOCAL_EXCHANGE,
    industry: null,
    sector: null,
    currency: null,
    description: meta.description || null,
    homepageUrl: null,
    totalEmployees: null,
    marketCap: null,
    figi: null,
    symbolType: null,
    securityType: null,
    iconUrl: null,
  };
}

/** Last daily bar of a local symbol and its change from the day before. */
export async function localSnapshot(symbol: string): Promise<Snapshot> {
  const meta = await metaOf(symbol);
  const daily = await localDailyBars(symbol);
  const last = daily[daily.length - 1];
  if (!last) throw new Error("no bar");
  const prev = daily.length > 1 ? daily[daily.length - 2] : last;
  const change = (last.close as number) - (prev.close as number);
  return {
    ticker: meta.name,
    last: last.close as number,
    change,
    changePercent: prev.close ? (change / Math.abs(prev.close)) * 100 : 0,
    dayHigh: last.high as number,
    dayLow: last.low as number,
    dayVolume: last.volume as number,
    extChangePercent: null,
    source: "prev",
    updatedMs: (last.time as number) * 1000,
  };
}

export type ImportResult = { series: LocalSeries; skipped: number };

/** Read a CSV file into the series `name` (replacing one of that name).
 *  Throws with a message for the user. */
export async function importLocalSeries(opts: {
  name: string;
  /** The file's text, or its bars already read (in `timeZone`). */
  csv: string | ParsedBars;
  timeZone: string;
  description?: string;
  /** Price grid to use instead of the file's decimals (a Pine Seeds symbol_info). */
  pricescale?: number;
  /** The synced folder's file it comes from (#267); none: imported by hand. */
  source?: LocalSource | null;
  /** A batch of files: the caller tells the app once, after the last one
   *  (localSeriesChanged), instead of after each. */
  deferRefresh?: boolean;
}): Promise<ImportResult> {
  const name = opts.name.trim().toUpperCase();
  if (!SERIES_NAME.test(name)) throw new Error("A name is 1 to 42 characters: A-Z, 0-9, '.', '_' or '-'.");
  const parsed = typeof opts.csv === "string" ? parseBarsCsv(opts.csv, opts.timeZone) : opts.csv;
  const n = parsed.rows.length / ROW;
  const series: LocalSeries = {
    name,
    description: opts.description?.trim() ?? "",
    timezone: opts.timeZone,
    base: parsed.base,
    pricescale: opts.pricescale ?? parsed.pricescale,
    hasVolume: parsed.hasVolume,
    bars: n,
    first: parsed.rows[0],
    last: parsed.rows[(n - 1) * ROW],
    imported: Date.now(),
    source: opts.source ?? null,
  };
  const r = await commands.localSeriesSave(series, parsed.rows);
  if (r.status === "error") throw new Error(r.error);
  if (!opts.deferRefresh) await localSeriesChanged([name]);
  return { series, skipped: parsed.skipped };
}

/** Remove a series. `deferRefresh`: see importLocalSeries. */
export async function deleteLocalSeries(name: string, deferRefresh = false): Promise<void> {
  const r = await commands.localSeriesDelete(name);
  if (r.status === "error") throw new Error(r.error);
  if (!deferRefresh) await localSeriesChanged([name]);
}

export async function renameLocalSeries(from: string, to: string): Promise<void> {
  const target = to.trim().toUpperCase();
  if (!SERIES_NAME.test(target)) throw new Error("A name is 1 to 42 characters: A-Z, 0-9, '.', '_' or '-'.");
  const r = await commands.localSeriesRename(from, target);
  if (r.status === "error") throw new Error(r.error);
  await localSeriesChanged([from, target]);
}

/** App-wide event of series that changed, so the other windows read them again. */
const CHANGED_EVENT = "local-series://changed";
const HAS_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
/** This window, to skip its own events. */
const SELF = Math.random().toString(36).slice(2);

/** The series `names` were stored, replaced or removed: this window and the
 *  others read the list and those bars again, and their charts reload. */
export async function localSeriesChanged(names: string[]): Promise<void> {
  if (names.length === 0) return;
  await refresh(names);
  if (HAS_TAURI) void emit(CHANGED_EVENT, { window: SELF, names }).catch(() => {});
}

async function refresh(names: string[]): Promise<void> {
  for (const name of names) forget(name);
  await reload();
  emitAppEvent("chart-reload-data");
}

if (HAS_TAURI) {
  void listen<{ window: string; names: string[] }>(CHANGED_EVENT, (e) => {
    // Nothing read yet in this window: it reads the list when it first needs it.
    if (e.payload.window !== SELF && loaded) void refresh(e.payload.names).catch(() => {});
  }).catch(() => {});
}

/** Drop what was read of a series: its charts read it again on the
 *  "chart-reload-data" that follows (as the ADJ toggle). */
function forget(name: string): void {
  barsCache.delete(name);
  dailyCache.delete(name);
  forgetSymbolSessions(localSymbol(name));
}
