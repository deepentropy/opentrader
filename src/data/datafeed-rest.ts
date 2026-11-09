/*
 * Datafeed REST calls — the backend history and reference commands
 * (aggregates, scroll-back pagers, ticker info/snapshot, headlines) behind the
 * datafeed facade. Vendor-neutral: which provider serves a call is the
 * backend's concern (see `data/provider`). What lives here is only what the
 * generated commands don't do: routing imported series to ./local-series,
 * retrying a lost connection and sharing one request between callers.
 */
import * as gen from "../bindings";
import { commands, type Candle, type History, type TickerInfo } from "../bindings";
import { retryTransient } from "./connection";
import { isLocalSymbol, localSnapshot, localTickerInfo } from "./local-series";

export type { TickerInfo } from "../bindings";

/** `T` with the fields `K` never null. The generated types read every Rust
 *  `f64` as `number | null` (serde would write a NaN as null); the backend only
 *  sends finite numbers in the fields named here, so the feed promises numbers.
 *  `Option` fields stay nullable. */
export type Finite<T, K extends keyof T> = Omit<T, K> & { [P in K]: NonNullable<T[P]> };

/** Latest quote of a symbol; `source` is "live" when today's session traded, else "prev". */
export type Snapshot = Omit<
  Finite<gen.Snapshot, "last" | "change" | "changePercent" | "dayHigh" | "dayLow" | "dayVolume" | "updatedMs">,
  "source"
> & { source: "live" | "prev" };
/** One headline for the chart's "Latest news" lollipop (newest first); `published` is UNIX ms. */
export type NewsItem = Finite<gen.NewsItem, "published">;

type CommandResult<T> = { status: "ok"; data: T } | { status: "error"; error: string };

/** A command's value, or its error thrown as the backend sent it: callers and
 *  ./connection read that text to tell a lost connection from a final failure. */
export async function unwrap<T>(result: Promise<CommandResult<T>>): Promise<T> {
  const r = await result;
  if (r.status === "error") throw r.error;
  return r.data;
}

/** Fetch `mult`-second OHLC bars for `symbol` over the trailing `days`.
 *  Throws on backend error (the caller wraps in try/catch). */
export async function getSecondHistory(
  symbol: string,
  mult: number,
  days: number,
  adjusted = true,
): Promise<History> {
  return unwrap(commands.getSecondHistory(symbol, mult, days, adjusted));
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
  return unwrap(commands.getSecondHistoryTail(symbol, mult, sinceSec, adjusted));
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
  return unwrap(commands.getAggregatesBefore(symbol, timespan, mult, beforeSec, spanDays, adjusted));
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
  return unwrap(commands.getDailyHistoryBefore(symbol, beforeSec, spanDays, adjusted));
}

/** Reference data changes at most once a day: an answer is reused for an hour. */
const INFO_TTL_MS = 60 * 60_000;

/** Ticker info requests, one per symbol: every caller waiting out a lost
 *  connection shares one retry loop, and the answer serves every caller for
 *  INFO_TTL_MS. A failure is not kept. */
const infoCache = new Map<string, { at: number; p: Promise<TickerInfo> }>();

/** Reference data of `symbol`; a server that cannot be reached is tried again
 *  until it answers (see ./connection). */
export function getTickerInfo(symbol: string): Promise<TickerInfo> {
  if (isLocalSymbol(symbol)) return localTickerInfo(symbol);
  const hit = infoCache.get(symbol);
  if (hit && Date.now() - hit.at < INFO_TTL_MS) return hit.p;
  const p = retryTransient(() => unwrap(commands.getTickerInfo(symbol)));
  const entry = { at: Date.now(), p };
  infoCache.set(symbol, entry);
  p.then(
    () => { entry.at = Date.now(); },
    () => { if (infoCache.get(symbol) === entry) infoCache.delete(symbol); },
  );
  return p;
}

/** Latest quote of `symbol`; a server that cannot be reached is tried again
 *  while `wanted()` holds (see ./connection). */
export function getTickerSnapshot(symbol: string, wanted?: () => boolean): Promise<Snapshot> {
  if (isLocalSymbol(symbol)) return localSnapshot(symbol);
  return retryTransient(() => unwrap(commands.getTickerSnapshot(symbol)) as Promise<Snapshot>, wanted);
}

/** Charts of the same symbol refresh their headline on the same period: one
 *  request serves them all for NEWS_SHARE_MS. */
const NEWS_SHARE_MS = 60_000;
const newsCache = new Map<string, { at: number; p: Promise<NewsItem[]> }>();

/** Newest `limit` headlines tagged with `symbol`. Rejects on backend failure;
 *  a failure is not kept. */
export function getLatestNews(symbol: string, limit = 1): Promise<NewsItem[]> {
  if (isLocalSymbol(symbol)) return Promise.resolve([]);
  const key = `${symbol}|${limit}`;
  const hit = newsCache.get(key);
  if (hit && Date.now() - hit.at < NEWS_SHARE_MS) return hit.p;
  const p = unwrap(commands.getLatestNews(symbol, limit)) as Promise<NewsItem[]>;
  const entry = { at: Date.now(), p };
  newsCache.set(key, entry);
  p.catch(() => { if (newsCache.get(key) === entry) newsCache.delete(key); });
  return p;
}
