/*
 * Datafeed REST wrappers — typed `invoke()` shims over the backend history and
 * reference commands (aggregates, scroll-back pagers, ticker info/snapshot).
 * Vendor-neutral: which provider serves a call is the backend's concern (see
 * `data/provider`). Hand-written (parallel to bindings.ts) so the chart can wire
 * new commands before bindings.ts regenerates on the next debug-build run; once
 * tauri-specta regenerates, these wrappers stay valid alongside it.
 */
import { invoke } from "@tauri-apps/api/core";
import type { Candle } from "../bindings";

/** Fetch `mult`-second OHLC bars for `symbol` over the trailing `days`.
 *  Throws on backend error (the caller wraps in try/catch). */
export async function getSecondHistory(
  symbol: string,
  mult: number,
  days: number,
  adjusted = true,
): Promise<Candle[]> {
  return invoke<Candle[]>("get_second_history", { symbol, mult, days, adjusted });
}

/** Live-tail refresh for the seconds frames: `mult`-second bars strictly newer
 *  than `sinceSec`. The 30s refresh loop merges these instead of refetching the
 *  whole 1-3 day window. Throws on backend error. */
export async function getSecondHistoryTail(
  symbol: string,
  mult: number,
  sinceSec: number,
  adjusted = true,
): Promise<Candle[]> {
  return invoke<Candle[]>("get_second_history_tail", { symbol, mult, sinceSec, adjusted });
}

/** Scroll-back pager for the REST frames (seconds + minutes): one older window
 *  of `mult`-`timespan` bars strictly before `beforeSec` (the time, in seconds,
 *  of the chart's oldest loaded bar). `spanDays` sizes the window. Returns `[]`
 *  when no older bars exist (history exhausted). Throws on backend error. */
export async function getAggregatesBefore(
  symbol: string,
  timespan: "second" | "minute",
  mult: number,
  beforeSec: number,
  spanDays: number,
  adjusted = true,
): Promise<Candle[]> {
  return invoke<Candle[]>("get_aggregates_before", {
    symbol,
    timespan,
    mult,
    beforeSec,
    spanDays,
    adjusted,
  });
}

/** Scroll-back pager for the daily family (1D/1W/1M): older daily candles
 *  strictly before `beforeSec`, from the same S3 source as the initial daily
 *  load. The caller keeps the underlying daily bars and re-aggregates 1W/1M.
 *  Returns `[]` when exhausted. Throws on backend error. */
export async function getDailyHistoryBefore(
  symbol: string,
  beforeSec: number,
  spanDays: number,
  adjusted = true,
): Promise<Candle[]> {
  return invoke<Candle[]>("get_daily_history_before", { symbol, beforeSec, spanDays, adjusted });
}

// ── WatchlistDetail data (Feature 6a) ────────────────────────────────────

export type TickerInfo = {
  ticker: string;
  name: string | null;
  exchange: string | null;
  industry: string | null;
  sector: string | null;
  currency: string | null;
  description: string | null;
  homepageUrl: string | null;
  totalEmployees: number | null;
  marketCap: number | null;
  figi: string | null;
  /** Branding icon via the `ticker-icon` proxy (Rust adds the token) — usable as <img src>. */
  iconUrl: string | null;
};

export type Snapshot = {
  ticker: string;
  last: number;
  change: number;
  changePercent: number;
  dayHigh: number;
  dayLow: number;
  dayVolume: number;
  /** Pre/post-market move vs the regular close; null mid-session. */
  extChangePercent: number | null;
  source: "live" | "prev";
  updatedNs: number;
};

export async function getTickerInfo(symbol: string): Promise<TickerInfo> {
  return invoke<TickerInfo>("get_ticker_info", { symbol });
}

export async function getTickerSnapshot(symbol: string): Promise<Snapshot> {
  return invoke<Snapshot>("get_ticker_snapshot", { symbol });
}

/** One headline for the chart's "Latest news" lollipop (newest first). */
export type NewsItem = {
  id: string;
  title: string;
  publisher: string;
  /** Publish time, UNIX ms. */
  published: number;
  url: string | null;
  description: string | null;
};

/** Newest `limit` headlines tagged with `symbol`; `[]` on backend failure. */
export async function getLatestNews(symbol: string, limit = 1): Promise<NewsItem[]> {
  return invoke<NewsItem[]>("get_latest_news", { symbol, limit });
}
