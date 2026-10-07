/*
 * Datafeed — the app's single normalized entry point for market data,
 * independent of which vendor the backend is wired to.
 *
 * Datafeed contract (resolveSymbol / getBars / subscribeBars), adapted to our
 * stack: lightweight-charts pulls nothing, so these are plain async methods
 * returning data rather than callback-style signatures. The point is
 * normalization — every access path (REST second/minute aggs, daily history,
 * scroll-back pagers, the live aggregate stream) is routed here behind one
 * resolution-keyed contract.
 * Consumers (ChartView, watchlist detail, …) ask for a resolution and a symbol
 * and get bars; they never learn which Rust command served them, and the Rust
 * side in turn hides which vendor served it (see `data/provider` — the
 * DataProvider trait). The little vendor-specific presentation that can't be
 * expressed generically (exchange-code naming) lives in `./providers`.
 *
 * Time is UNIX seconds everywhere (lightweight-charts UTCTimestamp), matching
 * the backend `Candle.time`.
 */
import { commands, type Candle, type SymbolSearchResult } from "../bindings";
import {
  getSecondHistory,
  getSecondHistoryTail,
  getAggregatesBefore,
  getDailyHistoryBefore,
  getTickerInfo,
} from "./datafeed-rest";
import { getItem } from "./kv";
import {
  onChartAggregate,
  onSecondAggregate,
  type ChartAggregate,
  type SecondAggregate,
} from "./datafeed-live";
import { exchangeCode, exchangeName } from "./providers";
import { isFullSymbol, splitSymbol } from "./symbol-name";
import { providerCapabilities, providerServes } from "./providers/capabilities";
import { localDay, localToUtc, symbolSessions, cachedSymbolSessions, type SessionId, type SessionSpec } from "./session";
import { aggregateCandles, periodStart, type AggregatePeriod } from "../window/chart/chart-aggregate";
import type { UnlistenFn } from "@tauri-apps/api/event";

// Re-export so consumers have one import surface for the daily-aggregation
// helpers as well as the feed itself.
export { aggregateCandles } from "../window/chart/chart-aggregate";
export type { AggregatePeriod } from "../window/chart/chart-aggregate";
// The live-symbol subscription lifecycle is part of the feed contract; expose
// it under the feed's vocabulary while delegating to the existing wrapper.
export { setChartSubscription as setLiveSymbol } from "./datafeed-live";
// Quote feed (the quotes half of the contract): the per-symbol trade-tick
// stream and the shared watchlist subscription slot it rides on. Watchlist rows
// and the alert engine consume these; the subscriptions coordinator drives the
// shared slot. All route through the feed rather than reaching into datafeed-live.
export { onTradeTick, setWatchlistSubscription } from "./datafeed-live";
export type { TradeTick } from "./datafeed-live";
// Reference info + live snapshot are part of the feed's symbol contract; expose
// them here so consumers (watchlist, detail panel) have one front door rather
// than reaching into datafeed-rest directly.
export { getTickerInfo, getTickerSnapshot } from "./datafeed-rest";
export type { TickerInfo, Snapshot } from "./datafeed-rest";
export type { SymbolSearchResult } from "../bindings";

// ── Resolution map ────────────────────────────────────────────────────────
// The canonical routing table: an interval id → which source serves it and
// how much history to pull. This was previously inlined in ChartView; it is
// the heart of the normalization.

/** Second-granularity interval ids → (bucket seconds, lookback days).
 *  Served by the backend's REST second aggregates. Lookback stays
 *  tight: a single RTH session of 1-second bars is ~23,400 points, comfortably
 *  under the API's 50k cap. */
const SECOND_INTERVALS: Record<string, { mult: number; days: number }> = {
  "1S": { mult: 1, days: 1 },
  "5S": { mult: 5, days: 1 },
  "10S": { mult: 10, days: 2 },
  "15S": { mult: 15, days: 2 },
  "30S": { mult: 30, days: 3 },
  "45S": { mult: 45, days: 3 },
};

/** Intraday interval ids → (lookback days, bucket minutes). Served by
 *  the backend's minute aggregates (server-side bucketing). */
const INTRADAY_INTERVALS: Record<string, { days: number; mins: number }> = {
  "1": { days: 5, mins: 1 },
  "5": { days: 10, mins: 5 },
  "15": { days: 30, mins: 15 },
  "30": { days: 60, mins: 30 },
  "60": { days: 90, mins: 60 },
  "120": { days: 180, mins: 120 },
  "240": { days: 252, mins: 240 },
};

/** Daily-or-coarser intervals → (lookback trading days, optional client
 *  aggregation, initial view window). `1W`/`1M` (and every other N-day, N-week
 *  or N-month id, see {@link dailyConfig}) fetch daily bars and aggregate them
 *  client-side (the backend serves only daily + minute).
 *
 *  The whole available daily history is loaded up-front (the backend clamps the
 *  request to the key's probed history floor and puts the archived sessions
 *  older than it in front, see {@link DAILY_ARCHIVE_START}), so the full series
 *  is in memory and scrolling back is instant — never a network round-trip.
 *  30 years of sessions: more than the backend calendar reaches. `view` is how
 *  many of the most-recent *display* bars to frame on load (null → fit all):
 *  `1D` opens on ~1 year with the rest preloaded behind it. */
const DAILY_FULL_DAYS = 7560;
/** First session of the daily archive (ISO date). A daily series that starts
 *  there is cut by the archive, not by the symbol's listing. */
export const DAILY_ARCHIVE_START = "2003-09-10";
type DailyConfig = { days: number; aggregate?: AggregatePeriod; view: number | null };
const DAILY_INTERVALS: Record<string, DailyConfig> = {
  "1D": { days: DAILY_FULL_DAYS, view: 252 },
  "1W": { days: DAILY_FULL_DAYS, aggregate: { unit: "week", n: 1 }, view: null },
  "1M": { days: DAILY_FULL_DAYS, aggregate: { unit: "month", n: 1 }, view: null },
};

/** Largest multiplier of each custom-interval type (the reference app's
 *  "Add custom interval" limits). */
const MAX_MULTIPLIER = { minute: 1440, day: 365, week: 52, month: 12 } as const;

/** Minute-family interval of any id: the table entry, or a custom N-minute
 *  id (hours are ids in minutes: "180" = 3H) whose lookback is the one of the
 *  largest table size at or under N. Null for other ids. */
function minuteConfig(resolution: string): { days: number; mins: number } | null {
  const known = INTRADAY_INTERVALS[resolution];
  if (known) return known;
  if (!/^[1-9]\d*$/.test(resolution)) return null;
  const mins = Number(resolution);
  if (mins > MAX_MULTIPLIER.minute) return null;
  let days = INTRADAY_INTERVALS["1"].days;
  for (const iv of Object.values(INTRADAY_INTERVALS)) if (iv.mins <= mins) days = iv.days;
  return { days, mins };
}

/** Daily-family interval of any id: the table entry, or a custom "ND" / "NW"
 *  / "NM" id built from daily bars. Null for other ids. */
function dailyFamily(resolution: string): DailyConfig | null {
  const known = DAILY_INTERVALS[resolution];
  if (known) return known;
  const m = /^([1-9]\d*)([DWM])$/.exec(resolution);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2] === "D" ? "day" : m[2] === "W" ? "week" : "month";
  if (n > MAX_MULTIPLIER[unit]) return null;
  return { days: DAILY_FULL_DAYS, aggregate: { unit, n }, view: null };
}

function dailyConfig(resolution: string): DailyConfig {
  return dailyFamily(resolution) ?? { days: DAILY_FULL_DAYS, view: 252 };
}

/** Number of most-recent display bars to frame on the initial daily load, or
 *  null to fit the whole loaded series. */
export function initialViewBars(resolution: string): number | null {
  return dailyConfig(resolution).view;
}

/** True when this resolution is served as second-granularity REST aggregates. */
export function isSecondResolution(resolution: string): boolean {
  return resolution in SECOND_INTERVALS;
}

/** True when this resolution is served as intraday minute aggregates (the only
 *  family that takes live per-minute bar updates — see {@link bucketLiveTick}). */
export function isIntradayResolution(resolution: string): boolean {
  return minuteConfig(resolution) !== null;
}

/** The single source of truth for what the feed can actually serve: a
 *  second-table id, any N-minute id (N ≤ 1440), or any daily-family id
 *  (N ≤ 365 days, 52 weeks, 12 months) AND served by the active provider (its
 *  reported capabilities — see ./providers/capabilities). This is our
 *  `onReady.supported_resolutions` equivalent: the interval picker gates on it
 *  (so unservable intervals aren't selectable) and {@link getBars} validates
 *  against it (so an unknown id errors instead of silently falling back to
 *  daily bars). Ticks and ranges are not served. Reactive: reads the
 *  capabilities signal. */
export function isSupportedResolution(resolution: string): boolean {
  const second = SECOND_INTERVALS[resolution];
  if (second) return providerServes("second", second.mult);
  const intra = minuteConfig(resolution);
  // A size the provider does not serve, or whose buckets straddle the session
  // open, is rebuilt from a finer served base (see sessionBaseMinutes); 1 is
  // the finest.
  if (intra) return servedMinutes().some((m) => intra.mins % m === 0);
  const daily = dailyFamily(resolution);
  if (daily) return providerServes(daily.aggregate ? "weekMonth" : "day");
  return false;
}

/** Minute bar sizes the provider serves. */
function servedMinutes(): number[] {
  return providerCapabilities()?.resolutions.minutes ?? Object.values(INTRADAY_INTERVALS).map((i) => i.mins);
}

/** All served interval ids (second → intraday → daily order). */
export function supportedResolutions(): string[] {
  return [
    ...Object.keys(SECOND_INTERVALS),
    ...Object.keys(INTRADAY_INTERVALS),
    ...Object.keys(DAILY_INTERVALS),
  ].filter(isSupportedResolution);
}

/** Client-side aggregation period applied to the daily series for this
 *  resolution (N days with N > 1, N weeks, N months), or null when the raw
 *  daily bars are shown. */
export function aggregateUnitFor(resolution: string): AggregatePeriod | null {
  return dailyConfig(resolution).aggregate ?? null;
}

// ── Symbol helpers ──────────────────────────────────────────────────────────

export { splitSymbol, tickerOf, isFullSymbol } from "./symbol-name";

// Exchange-code naming is the one vendor-specific presentation transform; it
// lives in the active provider adapter (./providers) and is re-exported here so
// the datafeed stays the single front door for consumers (e.g. WatchlistDetail).
export { exchangeName };

/** Tab-title-style interval label for the legend, mirroring the mock's
 *  `tabSuffix`: minutes keep their number, hours show "1H"/"2H"/"4H", and
 *  seconds/day/week/month keep their existing suffix form. */
export function intervalLabel(resolution: string): string {
  if (/^\d+[SsHhTt]$/.test(resolution) || /^1[DWM]$/.test(resolution) || /^\d+[DWM]$/.test(resolution))
    return resolution.toUpperCase();
  const n = Number(resolution);
  if (!Number.isNaN(n)) {
    if (n >= 60 && n % 60 === 0) return `${n / 60}H`;
    return resolution; // raw minute count, e.g. "5", "15"
  }
  return resolution;
}

/** True when the resolution carries intraday precision (no D/W/M suffix) — used
 *  to decide whether the time axis shows a clock component. Distinct from
 *  {@link isIntradayResolution}, which tests minute-aggregate table membership. */
export function isIntradayInterval(resolution: string): boolean {
  return !/[DWM]$/.test(resolution.toUpperCase());
}

// ── Symbol resolution ────────────────────────────────────────────────────────

export type SymbolInfo = {
  exchange: string;
  ticker: string;
  /** "EXCHANGE:TICKER". */
  fullName: string;
  description: string;
  currency: string | null;
};

/** Resolve a symbol (bare ticker or "EXCHANGE:TICKER") to its display metadata
 *  via the backend reference lookup. The normalized place to turn a user's
 *  symbol into exchange/description/currency. A full name keeps its exchange;
 *  a bare ticker gets its primary listing. */
export async function resolveSymbol(symbol: string): Promise<SymbolInfo> {
  const { ticker } = splitSymbol(symbol);
  const info = await getTickerInfo(symbol);
  const code = isFullSymbol(symbol) ? splitSymbol(symbol).exchange.toUpperCase() : exchangeCode(info.exchange);
  return {
    exchange: exchangeName(info.exchange) || code,
    ticker,
    fullName: `${code}:${ticker.toUpperCase()}`,
    description: info.name ?? "",
    currency: info.currency,
  };
}

const fullNames = new Map<string, Promise<string>>();

/** Full name ("NASDAQ:AAPL") of a symbol: as is when it has an exchange,
 *  else its primary listing from the provider's reference data (one lookup
 *  per ticker per run). Rejects when the lookup fails. */
export function toFullSymbol(symbol: string): Promise<string> {
  const s = symbol.trim().toUpperCase();
  if (isFullSymbol(s)) return Promise.resolve(s);
  let p = fullNames.get(s);
  if (!p) {
    p = resolveSymbol(s).then((r) => r.fullName);
    p.catch(() => fullNames.delete(s));
    fullNames.set(s, p);
  }
  return p;
}

/** Symbol typeahead via the backend symbol search. `type` is an optional
 *  vendor security-type filter (e.g. Massive's "CS", "ETF"; null = all types).
 *  Returns raw reference results; presentation/ranking into dialog rows stays in
 *  symbol-search.ts (liveResultsToRows). Throws on backend error so the caller
 *  can fall back to its static catalogue. */
export async function searchSymbols(
  query: string,
  type: string | null,
): Promise<SymbolSearchResult[]> {
  const res = await commands.searchTickers(query, type);
  if (res.status === "error") throw new Error(res.error);
  return res.data;
}

// ── Chart events (Events tab: Dividends / Splits) ────────────────────────────

/** One chart event marker. `time` is UNIX seconds (the ex-div / execution date
 *  at 00:00 UTC); `label` is the short caption ("0.27", "4:1"). */
export type ChartEvent = { time: number; kind: "dividend" | "split"; label: string };

/** Dividend + split markers for `symbol`, time-ascending. Best-effort: a failing
 *  endpoint contributes nothing rather than throwing (events are decorative). */
export async function getEvents(symbol: string): Promise<ChartEvent[]> {
  const [divs, splits, sessions] = await Promise.all([
    commands.getDividends(symbol),
    commands.getSplits(symbol),
    symbolSessions(symbol),
  ]);
  // Event dates arrive as 00:00 UTC of the calendar date; place them on that
  // date's daily-bar stamp (local midnight in the exchange zone).
  const onDay = (utcMidnight: number) => localToUtc(sessions.timeZone, Math.floor(utcMidnight / 86400), 0);
  const out: ChartEvent[] = [];
  if (divs.status === "ok") {
    for (const d of divs.data) {
      if (d.date != null) out.push({ time: onDay(d.date), kind: "dividend", label: (d.amount ?? 0).toFixed(2) });
    }
  }
  if (splits.status === "ok") {
    for (const s of splits.data) {
      if (s.date != null) out.push({ time: onDay(s.date), kind: "split", label: `${s.to ?? 1}:${s.from ?? 1}` });
    }
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

// ── Session (regular vs extended hours) ──────────────────────────────────────
// The bottom-bar RTH/ETH toggle. Provider aggregates carry NO session flag and
// are aligned on the clock, so the session comes from the symbol's own
// schedule (./session, reported by the provider per symbol):
//   • bars outside the chosen session (regular, or the extended day) are
//     dropped;
//   • when the bar size divides every session open (minutes after local
//     midnight), the provider's clock-aligned buckets already break there and
//     the filter is exact;
//   • otherwise (US 1H/2H/4H RTH: 09:30 open) the buckets straddle the open,
//     so a finer base that divides it is fetched, filtered, and re-aggregated
//     ANCHORED AT EACH SESSION INTERVAL's start (09:30, 10:30, …).

export type { SessionId } from "./session";

/** Minutes after local midnight of every session open in `spec` over the
 *  week before `sec` (so day-of-week variants are seen). */
function sessionOpenMinutes(spec: SessionSpec, sec: number): number[] {
  const out = new Set<number>();
  const d = localDay(spec.timeZone, sec);
  for (let day = d - 7; day <= d; day++) {
    for (const iv of spec.dayIntervals(day)) {
      const m = Math.round((iv.start - localToUtc(spec.timeZone, day, 0)) / 60);
      out.add(((m % 1440) + 1440) % 1440);
    }
  }
  return [...out];
}

/** Base bar size (minutes) to rebuild `mins` bars anchored at the session
 *  open, or null when the provider serves `mins` and its own buckets already
 *  break at every open. The base is the largest served size that divides
 *  `mins` and every open. */
function sessionBaseMinutes(spec: SessionSpec, mins: number): number | null {
  const served = servedMinutes();
  const opens = spec.always ? [0] : sessionOpenMinutes(spec, Date.now() / 1000);
  if (served.includes(mins) && (spec.always || opens.every((m) => m % mins === 0))) return null;
  const fits = served.filter((m) => m < mins && mins % m === 0 && opens.every((o) => o % m === 0));
  if (fits.length === 0) throw new Error(`no base bar size to build ${mins}-minute session bars`);
  return Math.max(...fits);
}

/** Drop bars that start outside `spec`'s sessions. */
function inSession(rows: Candle[], spec: SessionSpec): Candle[] {
  if (spec.always) return rows;
  return rows.filter((c) => c.time != null && spec.contains(c.time as number));
}

/** Aggregate in-session base bars (time-ascending, on a size that divides the
 *  session opens) into `targetMins` buckets ANCHORED AT THEIR SESSION
 *  INTERVAL's start. The last bucket of an interval may be short (15:30–16:00).
 *  Each bucket is stamped with its start, even when its first base bar is
 *  missing. */
function aggregateSessionMinutes(rows: Candle[], spec: SessionSpec, targetMins: number): Candle[] {
  const out: Candle[] = [];
  const step = targetMins * 60;
  let curStart = NaN;
  let cur: Candle | null = null;
  for (const b of rows) {
    if (b.time == null || b.open == null || b.high == null || b.low == null || b.close == null) continue;
    const t = b.time as number;
    const iv = spec.at(t);
    if (!iv) continue;
    const start = iv.start + Math.floor((t - iv.start) / step) * step;
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

// ── Split adjustment (bottom-bar ADJ toggle) ─────────────────────────────────
// The toggle persists in kv; the feed reads it per fetch so no wiring from the
// bar to each chart is needed — BottomBar flips the flag and dispatches
// "chart-reload-data", and every subsequent fetch uses the new basis.

const ADJUSTED_KEY = "ot:adjusted";

/** Current split-adjustment preference (default ON). */
export function isAdjusted(): boolean {
  return getItem(ADJUSTED_KEY) !== "false";
}

// ── Historical bars ──────────────────────────────────────────────────────────

export type BarsResult = {
  /** Display bars: aggregated for N days (N > 1) / weeks / months, raw
   *  otherwise. Time-ascending. */
  bars: Candle[];
  /** Underlying daily bars for the daily family; null for second/minute.
   *  Kept so scroll-back can re-aggregate the *full* set (a boundary
   *  period never mis-buckets). */
  daily: Candle[] | null;
  /** Aggregation period applied to produce `bars` from `daily`; null otherwise. */
  aggregate: AggregatePeriod | null;
};

/** Fetch the initial window of bars for a resolution. Routes:
 *   • second (1S…45S)          → REST second aggregates
 *   • intraday (1…1440 min)    → REST minute aggregates (S3 fallback in Rust),
 *                                rebuilt from a served base when needed
 *   • daily family (ND/NW/NM)  → S3 daily flat files, aggregated client-side
 *  Throws on backend error (the caller decides how to degrade). */
export async function getBars(
  symbol: string,
  resolution: string,
  session: SessionId = "ETH",
): Promise<BarsResult> {
  // Guard the catch-all daily branch below: an unservable resolution (tick,
  // range, too large a multiplier) must error here rather than silently
  // resolve to daily bars. The picker gates on the same set, so this is a
  // defense-in-depth backstop (e.g. a persisted/typed interval).
  if (!isSupportedResolution(resolution)) {
    throw new Error(`unsupported resolution: ${resolution}`);
  }
  const adjusted = isAdjusted();
  const second = SECOND_INTERVALS[resolution];
  if (second) {
    const [bars, sessions] = await Promise.all([
      getSecondHistory(symbol, second.mult, second.days, adjusted),
      symbolSessions(symbol),
    ]);
    // Second buckets divide every minute open, so an exact filter suffices.
    return { bars: inSession(bars, sessions.spec(session)), daily: null, aggregate: null };
  }
  const intra = minuteConfig(resolution);
  if (intra) {
    const spec = (await symbolSessions(symbol)).spec(session);
    const base = sessionBaseMinutes(spec, intra.mins);
    const res = await commands.getMinuteHistory(symbol, intra.days, base ?? intra.mins, adjusted);
    if (res.status === "error") throw new Error(res.error);
    const rows = inSession(res.data, spec);
    return { bars: base ? aggregateSessionMinutes(rows, spec, intra.mins) : rows, daily: null, aggregate: null };
  }
  const cfg = dailyConfig(resolution);
  // The session is not needed to fetch daily bars, but resolving it with them
  // (in parallel) means every loaded chart knows its symbol's session (status,
  // countdown, profile periods).
  const [res, sessions] = await Promise.all([commands.getDailyHistory(symbol, cfg.days, adjusted), symbolSessions(symbol)]);
  if (res.status === "error") throw new Error(res.error);
  const daily = res.data;
  const bars = cfg.aggregate ? aggregateCandles(daily, cfg.aggregate, sessions.regular) : daily;
  return { bars, daily, aggregate: cfg.aggregate ?? null };
}

/** Scroll-back pager: one older window of source rows ending strictly before
 *  `beforeSec` (the time, in seconds, of the chart's oldest loaded bar). For
 *  the daily family these are raw daily candles (the caller prepends to its
 *  daily series and re-aggregates with {@link aggregateUnitFor}); for
 *  second/minute they are the displayed bars. Returns `[]` when exhausted. */
export async function getBarsBefore(
  symbol: string,
  resolution: string,
  beforeSec: number,
  session: SessionId = "ETH",
  /** Window size in trading days, overriding the interval's page size. Used by
   *  date-range / time sync to reach a target date in ONE request (the backend
   *  splits a long minute window into uncut 50-day requests fetched in
   *  parallel). */
  spanDays?: number,
): Promise<Candle[]> {
  const adjusted = isAdjusted();
  const second = SECOND_INTERVALS[resolution];
  if (second) {
    const [rows, sessions] = await Promise.all([
      getAggregatesBefore(symbol, "second", second.mult, beforeSec, spanDays ?? second.days, adjusted),
      symbolSessions(symbol),
    ]);
    return inSession(rows, sessions.spec(session));
  }
  const intra = minuteConfig(resolution);
  if (intra) {
    const days = spanDays ?? intra.days;
    // Mirror getBars' session handling so older pages stay session-consistent.
    const spec = (await symbolSessions(symbol)).spec(session);
    const base = sessionBaseMinutes(spec, intra.mins);
    const rows = inSession(await getAggregatesBefore(symbol, "minute", base ?? intra.mins, beforeSec, days, adjusted), spec);
    return base ? aggregateSessionMinutes(rows, spec, intra.mins) : rows;
  }
  return getDailyHistoryBefore(symbol, beforeSec, spanDays ?? dailyConfig(resolution).days, adjusted);
}

/** Seconds live tail: bars strictly newer than `sinceSec` for a second-family
 *  resolution (null for any other family). Session-filtered like
 *  {@link getBars} so the merged tail stays consistent with the displayed
 *  series; the caller (ChartView's 30s refresh loop) merges through its
 *  live-bar path. */
export function getSecondBarsTail(
  symbol: string,
  resolution: string,
  sinceSec: number,
  session: SessionId = "ETH",
): Promise<Candle[]> | null {
  const second = SECOND_INTERVALS[resolution];
  if (!second) return null;
  return Promise.all([getSecondHistoryTail(symbol, second.mult, sinceSec, isAdjusted()), symbolSessions(symbol)]).then(
    ([rows, sessions]) => inSession(rows, sessions.spec(session)),
  );
}

// ── Live bars ────────────────────────────────────────────────────────────────

export type LiveBar = {
  /** Bucket start (UNIX seconds) for the resolution. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** Daily-bar stamp of the tick's trading day (daily family only). For
   *  1W/1M the tick's `volume` covers TODAY only, not the forming bucket's
   *  cumulative — this lets the consumer reset its per-day volume baseline
   *  when the day advances (see ChartView's applyLiveBar). */
  dayTime?: number;
  /** `volume` covers only part of the bucket (a 1-second stream bar inside a
   *  5S…45S bucket): the consumer ADDS it to the bucket instead of replacing. */
  volumeIsIncrement?: boolean;
};

/** Daily-bar stamp of the trading day `timeSec` belongs to: local midnight
 *  of that day in the symbol's exchange time zone, the timestamp convention
 *  of the provider's daily bars (verified on the current provider: US daily
 *  bars stamp 04:00/05:00 UTC = 00:00 New York). The day is the one of the extended
 *  session in progress at `timeSec`, else of the last one that closed. */
function dailyBarStamp(spec: SessionSpec, timeSec: number): number {
  const day = spec.currentOrPrevious(timeSec)?.day ?? localDay(spec.timeZone, timeSec);
  return localToUtc(spec.timeZone, day, 0);
}

/** Bucket a raw per-minute aggregate tick into a bar for `resolution`. Returns
 *  null when the resolution does not take live bar updates (the second family:
 *  a minute aggregate cannot honestly form sub-minute bars — seconds take the
 *  1-second stream, see {@link bucketSecondBar}, plus the REST tail refetch in
 *  ChartView), so the caller skips it. The returned
 *  bar carries the *tick's* OHLC at the bucket boundary; the caller merges it
 *  into / appends it onto the loaded series. */
export function bucketLiveTick(
  resolution: string,
  tick: ChartAggregate,
  session: SessionId = "ETH",
): LiveBar | null {
  // Daily family (1D/1W/1M): the poller rides today's full-session day bar
  // along on the tick, so the update is exact (open/high/low cover the whole
  // session even when the app attached mid-day — a warm daily history load
  // deliberately skips today's forming bar and this fills it). Bucketed to
  // the daily-bar stamp, then to the week/month key for 1W/1M.
  // Session-independent, like the historical daily path (no RTH variant).
  // Sessions resolve before the first bars of a symbol: none yet means no
  // loaded series to update.
  const sessions = cachedSymbolSessions(tick.symbol);
  if (!sessions) return null;
  const dailyCfg = dailyFamily(resolution);
  if (dailyCfg) {
    // Day-bar only: pre-market snapshots carry no day bar yet (today's daily
    // candle shows only once the regular session trades), and the minute bar
    // would fabricate one from pre-market prices.
    const src = tick.day;
    if (!src) return null;
    // A day-only tick (no minute bar in the snapshot) stamps time=0; fall back
    // to the day bar's own update stamp for the trading-day derivation.
    const dayTime = dailyBarStamp(sessions.extended, tick.time > 0 ? tick.time : src.time);
    return {
      time: dailyCfg.aggregate ? periodStart(dayTime, dailyCfg.aggregate, sessions.regular) : dayTime,
      open: src.open,
      high: src.high,
      low: src.low,
      close: src.close,
      volume: src.volume,
      dayTime,
    };
  }
  const intra = minuteConfig(resolution);
  if (!intra) return null;
  // Day-only fallback ticks (time=0) carry day OHLC, not a minute bar — they
  // must never form an intraday bucket.
  if (tick.time <= 0) return null;
  const spec = sessions.spec(session);
  // A tick outside the chosen session has no bar to extend (RTH: pre/post).
  const iv = spec.at(tick.time);
  if (!iv) return null;
  const bucketSecs = intra.mins * 60;
  // Re-aggregated sizes (US 1H/2H/4H RTH) anchor at the session interval's
  // start like the history; the others keep the provider's clock grid, which
  // already breaks at the open.
  const bucketTime =
    sessionBaseMinutes(spec, intra.mins) !== null
      ? iv.start + Math.floor((tick.time - iv.start) / bucketSecs) * bucketSecs
      : Math.floor(tick.time / bucketSecs) * bucketSecs;
  return {
    time: bucketTime,
    open: tick.open,
    high: tick.high,
    low: tick.low,
    close: tick.close,
    volume: tick.volume,
  };
}

/** Bucket a 1-second stream bar into a bar for a second-family `resolution`
 *  (1S…45S). Null for any other family (minute / daily charts stay on the
 *  per-minute aggregates) and outside the chosen session. For buckets
 *  wider than one second the bar carries `volumeIsIncrement`. */
export function bucketSecondBar(
  resolution: string,
  bar: SecondAggregate,
  session: SessionId = "ETH",
): LiveBar | null {
  const second = SECOND_INTERVALS[resolution];
  if (!second) return null;
  const sessions = cachedSymbolSessions(bar.symbol);
  if (!sessions || !sessions.spec(session).contains(bar.time)) return null;
  return {
    time: Math.floor(bar.time / second.mult) * second.mult,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
    volumeIsIncrement: second.mult > 1,
  };
}

/** Subscribe to live bars for the symbol/resolution given by the accessors,
 *  reading them per-tick so the same listener follows symbol/interval changes.
 *  Two sources: the per-minute aggregates (minute + daily families) and the
 *  1-second stream (second family; only flows when the key is entitled — see
 *  ./providers/capabilities). Ticks for other symbols and non-bucketable
 *  resolutions are filtered out; `onBar` fires only with a resolution-bucketed
 *  {@link LiveBar}. Returns one unlisten handle for both. Declaring the symbol
 *  subscription on the backend is a separate concern — call
 *  {@link setLiveSymbol} for that. */
export async function subscribeBars(
  getSymbol: () => string | undefined,
  getResolution: () => string,
  onBar: (bar: LiveBar) => void,
  getSession: () => SessionId = () => "ETH",
): Promise<UnlistenFn> {
  const isCharted = (s: string) => {
    const sym = getSymbol();
    return !!sym && s.toUpperCase() === sym.toUpperCase();
  };
  const [offMinute, offSecond] = await Promise.all([
    onChartAggregate((tick) => {
      if (!isCharted(tick.symbol)) return;
      const bar = bucketLiveTick(getResolution(), tick, getSession());
      if (bar) onBar(bar);
    }),
    onSecondAggregate((tick) => {
      if (!isCharted(tick.symbol)) return;
      const bar = bucketSecondBar(getResolution(), tick, getSession());
      if (bar) onBar(bar);
    }),
  ]);
  return () => {
    offMinute();
    offSecond();
  };
}
