/*
 * The details panel's quote: the snapshot read when the symbol is selected,
 * moved by the live quotes the watchlist rows show (data/quotes.ts), so the
 * price, change, day's range and "Last update at" follow the feed instead of
 * staying at the selection time.
 */
import type { Snapshot } from "../../data/datafeed";
import type { LiveQuote } from "../../data/quotes";
import type { YearRange } from "./ticker-stats";

/** What the panel shows; a null field reads "—". `updatedMs` is UNIX ms, 0 when unknown. */
export type DetailQuote = {
  last: number | null;
  change: number | null;
  changePercent: number | null;
  extChangePercent: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  dayVolume: number | null;
  updatedMs: number;
  source: "live" | "prev" | null;
};

const MINUTE_MS = 60_000;

/** The snapshot with the live quote over it. A field the quote does not carry
 *  (a stream trade has only its price) keeps the snapshot's value. */
export function detailQuote(snap: Snapshot | null, live: LiveQuote | undefined): DetailQuote | null {
  const base: DetailQuote | null = snap && {
    last: snap.last,
    change: snap.change,
    changePercent: snap.changePercent,
    extChangePercent: snap.extChangePercent,
    dayHigh: snap.dayHigh,
    dayLow: snap.dayLow,
    dayVolume: snap.dayVolume,
    updatedMs: snap.updatedMs,
    source: snap.source,
  };
  if (!live) return base;
  // The store keeps a symbol's last quote after it leaves the lists: one older
  // than the snapshot's minute would take the panel back until the next tick.
  if (snap && live.time != null && live.time < Math.floor(snap.updatedMs / MINUTE_MS) * MINUTE_MS) return base;
  const high = live.dayHigh ?? base?.dayHigh ?? null;
  const low = live.dayLow ?? base?.dayLow ?? null;
  return {
    last: live.last,
    change: live.change ?? base?.change ?? null,
    changePercent: live.changePercent ?? base?.changePercent ?? null,
    extChangePercent: live.extChangePercent ?? base?.extChangePercent ?? null,
    // A stream trade between two full quotes can go past the range they gave.
    dayHigh: high == null ? null : Math.max(high, live.last),
    dayLow: low == null ? null : Math.min(low, live.last),
    dayVolume: live.volume ?? base?.dayVolume ?? null,
    updatedMs: Math.max(base?.updatedMs ?? 0, live.time ?? 0),
    source: live.source ?? base?.source ?? null,
  };
}

/** The 52 week range of the daily bars, widened to the day's range and price
 *  when they went past it since those bars were read. */
export function widenYearRange(year: YearRange | null, quote: DetailQuote | null): YearRange | null {
  if (!year || !quote || year.high == null || year.low == null) return year;
  const seen = [quote.dayHigh, quote.dayLow, quote.last].filter((n): n is number => n != null && Number.isFinite(n));
  if (seen.length === 0) return year;
  return { ...year, high: Math.max(year.high, ...seen), low: Math.min(year.low, ...seen) };
}
