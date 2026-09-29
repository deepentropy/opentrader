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
import { exchangeName, defaultExchange } from "./providers";
import { providerServes } from "./providers/capabilities";
import { aggregateCandles, bucketStart, type AggregateUnit } from "../window/chart/chart-aggregate";
import type { UnlistenFn } from "@tauri-apps/api/event";

// Re-export so consumers have one import surface for the daily-aggregation
// helpers as well as the feed itself.
export { aggregateCandles } from "../window/chart/chart-aggregate";
export type { AggregateUnit } from "../window/chart/chart-aggregate";
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
 *  aggregation, initial view window). `1W`/`1M` fetch daily bars and aggregate
 *  them client-side (the backend serves only daily + minute).
 *
 *  The whole available daily history is loaded up-front (the backend clamps the
 *  request to the key's probed history floor — 10 years on the current plan,
 *  checked 27/09/2026), so the full series is in memory
 *  and scrolling back is instant — never a network round-trip. `view` is how
 *  many of the most-recent *display* bars to frame on load (null → fit all):
 *  `1D` opens on ~1 year with the rest preloaded behind it. */
const DAILY_FULL_DAYS = 5040;
const DAILY_INTERVALS: Record<string, { days: number; aggregate?: AggregateUnit; view: number | null }> = {
  "1D": { days: DAILY_FULL_DAYS, view: 252 },
  "1W": { days: DAILY_FULL_DAYS, aggregate: "week", view: null },
  "1M": { days: DAILY_FULL_DAYS, aggregate: "month", view: null },
};

function dailyConfig(resolution: string): { days: number; aggregate?: AggregateUnit; view: number | null } {
  return DAILY_INTERVALS[resolution] ?? { days: DAILY_FULL_DAYS, view: 252 };
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
  return resolution in INTRADAY_INTERVALS;
}

/** The single source of truth for what the feed can actually serve: an
 *  interval id in the second, intraday, or daily-family table AND served by
 *  the active provider (its reported capabilities — see
 *  ./providers/capabilities). This is our `onReady.supported_resolutions`
 *  equivalent: the interval picker gates on it (so unservable intervals aren't
 *  selectable) and {@link getBars} validates against it (so an unknown id
 *  errors instead of silently falling back to daily bars). Resolutions the UI
 *  offers but the feed cannot serve — ticks, 2/3/4/10/45-min, 3H, 3M/6M,
 *  custom — are NOT in the tables by design. Reactive: reads the capabilities
 *  signal. */
export function isSupportedResolution(resolution: string): boolean {
  const second = SECOND_INTERVALS[resolution];
  if (second) return providerServes("second", second.mult);
  const intra = INTRADAY_INTERVALS[resolution];
  if (intra) {
    // 1H/2H/4H in RTH are built from a 30-min base (see getBars), so the
    // provider must serve both.
    return (
      providerServes("minute", intra.mins) &&
      (!needsSessionReaggregation(intra.mins) || providerServes("minute", 30))
    );
  }
  const daily = DAILY_INTERVALS[resolution];
  if (daily) return providerServes(daily.aggregate ? "weekMonth" : "day");
  return false;
}

/** All served interval ids (second → intraday → daily order). */
export function supportedResolutions(): string[] {
  return [
    ...Object.keys(SECOND_INTERVALS),
    ...Object.keys(INTRADAY_INTERVALS),
    ...Object.keys(DAILY_INTERVALS),
  ].filter(isSupportedResolution);
}

/** Client-side aggregation unit applied to the daily series for this
 *  resolution (`week`/`month`), or null when the raw daily bars are shown. */
export function aggregateUnitFor(resolution: string): AggregateUnit | null {
  return dailyConfig(resolution).aggregate ?? null;
}

// ── Symbol helpers ──────────────────────────────────────────────────────────

/** "EXCHANGE:TICKER" → its parts; bare tickers default to NASDAQ (mirrors the
 *  mock's splitSymbol). */
export function splitSymbol(symbol: string): { exchange: string; ticker: string } {
  const head = symbol.split(",")[0].trim();
  if (head.includes(":")) {
    const [exchange, ticker] = head.split(":");
    return { exchange, ticker };
  }
  return { exchange: defaultExchange(), ticker: head };
}

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
 *  symbol into exchange/description/currency. */
export async function resolveSymbol(symbol: string): Promise<SymbolInfo> {
  const { exchange, ticker } = splitSymbol(symbol);
  const info = await getTickerInfo(ticker);
  const ex = exchangeName(info.exchange) || exchange;
  return {
    exchange: ex,
    ticker,
    fullName: `${ex}:${ticker}`,
    description: info.name ?? "",
    currency: info.currency,
  };
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
  const [divs, splits] = await Promise.all([
    commands.getDividends(symbol),
    commands.getSplits(symbol),
  ]);
  const out: ChartEvent[] = [];
  if (divs.status === "ok") {
    for (const d of divs.data) {
      if (d.date != null) out.push({ time: d.date, kind: "dividend", label: (d.amount ?? 0).toFixed(2) });
    }
  }
  if (splits.status === "ok") {
    for (const s of splits.data) {
      if (s.date != null) out.push({ time: s.date, kind: "split", label: `${s.to ?? 1}:${s.from ?? 1}` });
    }
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

// ── Session (regular vs extended hours) ──────────────────────────────────────
// The bottom-bar RTH/ETH toggle. Our backend aggregates carry NO session flag
// — they always include extended hours (premarket from 04:00) and are
// midnight-aligned. So we compute the session ourselves (generic US-equity
// session logic, not vendor-specific):
//   • ETH → bars as-is (midnight-aligned hour buckets already break at 04:00,
//     the extended-session open).
//   • RTH → keep only 09:30–16:00 ET. For seconds + 1/5/15/30-min that's an
//     exact filter (09:30 is already a bucket edge). For 1H/2H/4H the hour
//     buckets straddle the open (the 09:00 bar mixes premarket + open), so we
//     fetch a 30-min base, filter, and re-aggregate anchored at 09:30.

export type SessionId = "RTH" | "ETH";

/** Regular US-equity session, defined in EXCHANGE-local time (independent of the
 *  chart's display timezone): 09:30–16:00 America/New_York. */
const RTH_TZ = "America/New_York";
const RTH_OPEN_MIN = 9 * 60 + 30; // 570
const RTH_CLOSE_MIN = 16 * 60; // 960

// Reused formatters (DST-correct): a bar's UNIX seconds → ET time-of-day / date.
const etTimeFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: RTH_TZ, hour12: false, hour: "2-digit", minute: "2-digit",
});
const etDateFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: RTH_TZ, year: "numeric", month: "2-digit", day: "2-digit",
});

/** Minutes since ET midnight for a bar time (UNIX seconds). */
function etMinutes(timeSec: number): number {
  const parts = etTimeFmt.formatToParts(new Date(timeSec * 1000));
  let h = 0, m = 0;
  for (const p of parts) {
    if (p.type === "hour") h = +p.value;
    else if (p.type === "minute") m = +p.value;
  }
  if (h === 24) h = 0; // midnight prints as "24" in some locales
  return h * 60 + m;
}

/** True when a bar's ET time-of-day falls in the regular 09:30–16:00 window. */
function isRegularHours(timeSec: number): boolean {
  const min = etMinutes(timeSec);
  return min >= RTH_OPEN_MIN && min < RTH_CLOSE_MIN;
}

/** Drop bars outside the regular session (used for the exact-filter family:
 *  seconds + 1/5/15/30-min, whose buckets already break at 09:30). */
function regularHoursOnly(rows: Candle[]): Candle[] {
  return rows.filter((c) => c.time != null && isRegularHours(c.time as number));
}

/** Aggregate regular-session minute bars (already filtered to 09:30–16:00,
 *  time-ascending, on a granularity that breaks at 09:30 — we use 30-min) into
 *  `targetMins` buckets ANCHORED AT THE SESSION OPEN. This is how 1H/2H/4H RTH
 *  bars line up at 09:30, 10:30, … (the raw provider bars can't — their hour buckets are
 *  midnight-aligned). The last bucket of a day may be short (15:30–16:00). */
function aggregateSessionMinutes(rows: Candle[], targetMins: number): Candle[] {
  const out: Candle[] = [];
  let curKey = "";
  let cur: Candle | null = null;
  for (const b of rows) {
    if (b.time == null || b.open == null || b.high == null || b.low == null || b.close == null) continue;
    const t = b.time as number;
    const day = etDateFmt.format(new Date(t * 1000));
    const bucket = Math.floor((etMinutes(t) - RTH_OPEN_MIN) / targetMins);
    const key = `${day}#${bucket}`;
    if (key !== curKey) {
      if (cur) out.push(cur);
      cur = { ...b };
      curKey = key;
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

/** True when this intraday resolution needs the 30-min-base re-aggregation for
 *  RTH (1H/2H/4H), as opposed to the exact filter (≤30-min + seconds). */
function needsSessionReaggregation(mins: number): boolean {
  return mins >= 60;
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
  /** Display bars: aggregated for 1W/1M, raw otherwise. Time-ascending. */
  bars: Candle[];
  /** Underlying daily bars for the daily family (1D/1W/1M); null for
   *  second/minute. Kept so scroll-back can re-aggregate the *full* set (a
   *  boundary week/month never mis-buckets). */
  daily: Candle[] | null;
  /** Aggregation unit applied to produce `bars` from `daily`; null otherwise. */
  aggregate: AggregateUnit | null;
};

/** Fetch the initial window of bars for a resolution. Routes:
 *   • second (1S…45S)          → REST second aggregates
 *   • intraday (1…240 min)     → REST minute aggregates (S3 fallback in Rust)
 *   • daily family (1D/1W/1M)  → S3 daily flat files, aggregated client-side
 *  Throws on backend error (the caller decides how to degrade). */
export async function getBars(
  symbol: string,
  resolution: string,
  session: SessionId = "ETH",
): Promise<BarsResult> {
  // Guard the catch-all daily branch below: an unservable resolution (tick,
  // 2/3/4/10/45-min, 3H, 3M/6M, custom) must error here rather than silently
  // resolve to daily bars. The picker gates on the same set, so this is a
  // defense-in-depth backstop (e.g. a persisted/typed/custom interval).
  if (!isSupportedResolution(resolution)) {
    throw new Error(`unsupported resolution: ${resolution}`);
  }
  const regular = session === "RTH";
  const adjusted = isAdjusted();
  const second = SECOND_INTERVALS[resolution];
  if (second) {
    const bars = await getSecondHistory(symbol, second.mult, second.days, adjusted);
    // Second buckets always break at 09:30, so an exact filter suffices.
    return { bars: regular ? regularHoursOnly(bars) : bars, daily: null, aggregate: null };
  }
  const intra = INTRADAY_INTERVALS[resolution];
  if (intra) {
    // 1H/2H/4H RTH: fetch a 30-min base, filter to the session, re-aggregate
    // anchored at the open (the raw hour buckets straddle 09:30).
    if (regular && needsSessionReaggregation(intra.mins)) {
      const res = await commands.getMinuteHistory(symbol, intra.days, 30, adjusted);
      if (res.status === "error") throw new Error(res.error);
      const bars = aggregateSessionMinutes(regularHoursOnly(res.data), intra.mins);
      return { bars, daily: null, aggregate: null };
    }
    const res = await commands.getMinuteHistory(symbol, intra.days, intra.mins, adjusted);
    if (res.status === "error") throw new Error(res.error);
    return { bars: regular ? regularHoursOnly(res.data) : res.data, daily: null, aggregate: null };
  }
  const cfg = dailyConfig(resolution);
  const res = await commands.getDailyHistory(symbol, cfg.days, adjusted);
  if (res.status === "error") throw new Error(res.error);
  const daily = res.data;
  const bars = cfg.aggregate ? aggregateCandles(daily, cfg.aggregate) : daily;
  return { bars, daily, aggregate: cfg.aggregate ?? null };
}

/** Scroll-back pager: one older window of source rows ending strictly before
 *  `beforeSec` (the time, in seconds, of the chart's oldest loaded bar). For
 *  the daily family these are raw daily candles (the caller prepends to its
 *  daily series and re-aggregates with {@link aggregateUnitFor}); for
 *  second/minute they are the displayed bars. Returns `[]` when exhausted. */
export function getBarsBefore(
  symbol: string,
  resolution: string,
  beforeSec: number,
  session: SessionId = "ETH",
  /** Window size in trading days, overriding the interval's page size. Used by
   *  date-range sync to reach a target date in ONE request (the backend still
   *  caps a request at 50k base units, keeping the most recent ones). */
  spanDays?: number,
): Promise<Candle[]> {
  const regular = session === "RTH";
  const adjusted = isAdjusted();
  const second = SECOND_INTERVALS[resolution];
  if (second)
    return getAggregatesBefore(symbol, "second", second.mult, beforeSec, spanDays ?? second.days, adjusted).then(
      (rows) => (regular ? regularHoursOnly(rows) : rows),
    );
  const intra = INTRADAY_INTERVALS[resolution];
  if (intra) {
    const days = spanDays ?? intra.days;
    // Mirror getBars' session handling so older pages stay session-consistent.
    if (regular && needsSessionReaggregation(intra.mins)) {
      return getAggregatesBefore(symbol, "minute", 30, beforeSec, days, adjusted).then((rows) =>
        aggregateSessionMinutes(regularHoursOnly(rows), intra.mins),
      );
    }
    return getAggregatesBefore(symbol, "minute", intra.mins, beforeSec, days, adjusted).then(
      (rows) => (regular ? regularHoursOnly(rows) : rows),
    );
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
  const regular = session === "RTH";
  return getSecondHistoryTail(symbol, second.mult, sinceSec, isAdjusted()).then((rows) =>
    regular ? regularHoursOnly(rows) : rows,
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
  /** Midnight-ET stamp of the tick's trading day (daily family only). For
   *  1W/1M the tick's `volume` covers TODAY only, not the forming bucket's
   *  cumulative — this lets the consumer reset its per-day volume baseline
   *  when the day advances (see ChartView's applyLiveBar). */
  dayTime?: number;
  /** `volume` covers only part of the bucket (a 1-second stream bar inside a
   *  5S…45S bucket): the consumer ADDS it to the bucket instead of replacing. */
  volumeIsIncrement?: boolean;
};

/** Midnight ET of the ET calendar date containing `timeSec`, in UNIX seconds —
 *  the timestamp convention of the provider's daily bars (verified: Massive
 *  daily aggs stamp 04:00/05:00 UTC = 00:00 New York). DST-safe: probes the
 *  two possible offsets and keeps the one that formats back to 00:00 on the
 *  same ET date. */
function etMidnightUtcSec(timeSec: number): number {
  const dstr = etDateFmt.format(new Date(timeSec * 1000)); // en-CA → YYYY-MM-DD
  const [y, m, d] = dstr.split("-").map(Number);
  for (const off of [4, 5]) {
    const cand = Date.UTC(y, m - 1, d, off) / 1000;
    if (etMinutes(cand) === 0 && etDateFmt.format(new Date(cand * 1000)) === dstr) return cand;
  }
  return Date.UTC(y, m - 1, d, 5) / 1000; // unreachable (EST fallback)
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
  // midnight-ET (the daily-bar stamp), then to the week/month key for 1W/1M.
  // Session-independent, like the historical daily path (no RTH variant).
  const dailyCfg = DAILY_INTERVALS[resolution];
  if (dailyCfg) {
    // Day-bar only: pre-market snapshots carry no day bar yet (today's daily
    // candle shows only once the regular session trades), and the minute bar
    // would fabricate one from pre-market prices.
    const src = tick.day;
    if (!src) return null;
    // A day-only tick (no minute bar in the snapshot) stamps time=0; fall back
    // to the day bar's own update stamp for the ET-date derivation.
    const dayTime = etMidnightUtcSec(tick.time > 0 ? tick.time : src.time);
    return {
      time: dailyCfg.aggregate ? bucketStart(dayTime, dailyCfg.aggregate) : dayTime,
      open: src.open,
      high: src.high,
      low: src.low,
      close: src.close,
      volume: src.volume,
      dayTime,
    };
  }
  const intra = INTRADAY_INTERVALS[resolution];
  if (!intra) return null;
  // Day-only fallback ticks (time=0) carry day OHLC, not a minute bar — they
  // must never form an intraday bucket.
  if (tick.time <= 0) return null;
  const regular = session === "RTH";
  // RTH: a premarket/after-hours tick has no regular-session bar to extend.
  if (regular && !isRegularHours(tick.time)) return null;
  let bucketTime: number;
  if (regular && needsSessionReaggregation(intra.mins)) {
    // 1H/2H/4H RTH buckets anchor at 09:30, not the UTC hour. Floor to the
    // minute, then subtract the tick's offset INTO its session bucket (whole
    // minutes — DST-safe, and matches the minute-aligned historical bars).
    const tMin = Math.floor(tick.time / 60) * 60;
    const intoBucket = (((etMinutes(tick.time) - RTH_OPEN_MIN) % intra.mins) + intra.mins) % intra.mins;
    bucketTime = tMin - intoBucket * 60;
  } else {
    // ≤30-min + seconds: midnight/UTC-hour-aligned floor already breaks at 09:30.
    const bucketSecs = intra.mins * 60;
    bucketTime = Math.floor(tick.time / bucketSecs) * bucketSecs;
  }
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
 *  per-minute aggregates) and, in RTH, outside 09:30–16:00 ET. For buckets
 *  wider than one second the bar carries `volumeIsIncrement`. */
export function bucketSecondBar(
  resolution: string,
  bar: SecondAggregate,
  session: SessionId = "ETH",
): LiveBar | null {
  const second = SECOND_INTERVALS[resolution];
  if (!second) return null;
  if (session === "RTH" && !isRegularHours(bar.time)) return null;
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
