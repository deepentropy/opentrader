/*
 * "Symbol info" dialog data (the reference dialog's rules):
 *  - the fields in two groups, two per row, a field without a value left out
 *    (no "-" rows): Symbol, Name, Sector, Industry, FIGI, Website (a stock) /
 *    Home page (a fund) | Type, Point value, Listed exchange, Currency, Tick
 *    size. The data served has no ISIN, CUSIP, CFI code nor sector, and no
 *    traded-exchange name: those rows do not show;
 *  - Type: the security type and its visible sub-type ("Fund ETF", "Stock",
 *    "DR"), first letter capitalised;
 *  - the session week: per day of the current week, its trading parts
 *    (pre-market, market open, post-market) in exchange minutes.
 */
import { localDay, localToUtc, weekdayOf, type SessionSpec } from "./session";

/** "Fund ETF", "Stock", "DR" for a security type as served ("etf", "stock", "adr"…); null when unknown. */
export function securityTypeLabel(kind: string | null | undefined): string | null {
  switch ((kind ?? "").toLowerCase()) {
    case "stock":
    case "preferred":
      return "Stock";
    case "etf":
      return "Fund ETF";
    case "etn":
      return "Fund ETN";
    case "etv":
    case "fund":
      return "Fund";
    case "adr":
      return "DR";
    case "warrant":
      return "Warrant";
    case "right":
      return "Right";
    case "unit":
      return "Unit";
    default:
      return null;
  }
}

/** One field of the dialog. `link`: opens in the browser (value = its host name); `copy`: has a copy button. */
export type InfoField = { title: string; value: string; link?: string; copy?: boolean; flag?: string };

export type InfoInput = {
  /** Full symbol ("AMEX:SPY"). */
  symbol: string;
  name?: string | null;
  sector?: string | null;
  industry?: string | null;
  figi?: string | null;
  homepageUrl?: string | null;
  /** Security type as served ("etf", "stock"…). */
  securityType?: string | null;
  /** Listing exchange as the symbol names it ("AMEX"). */
  listedExchange?: string | null;
  /** Its country flag (an image URL). */
  flag?: string | null;
  currency?: string | null;
  tickSize?: string | null;
};

/** Host name of a URL without "www." (the reference shows the site that way). */
export function siteName(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** The two groups of fields. */
export function symbolInfoGroups(i: InfoInput): InfoField[][] {
  const kind = (i.securityType ?? "").toLowerCase();
  const isFund = ["etf", "etn", "etv", "fund"].includes(kind);
  const isStock = kind === "stock" || kind === "preferred";
  const first: InfoField[] = [{ title: "Symbol", value: i.symbol }];
  if (i.name) first.push({ title: "Name", value: i.name });
  if (i.sector) first.push({ title: "Sector", value: i.sector });
  if (i.industry) first.push({ title: "Industry", value: i.industry });
  if (i.figi) first.push({ title: "FIGI", value: i.figi, copy: true });
  if (i.homepageUrl && (isStock || isFund)) first.push({ title: isStock ? "Website" : "Home page", value: siteName(i.homepageUrl), link: i.homepageUrl });
  const second: InfoField[] = [];
  const type = securityTypeLabel(i.securityType);
  if (type) second.push({ title: "Type", value: type });
  second.push({ title: "Point value", value: "1" });
  if (i.listedExchange) second.push({ title: "Listed exchange", value: i.listedExchange, ...(i.flag ? { flag: i.flag } : {}) });
  if (i.currency) second.push({ title: "Currency", value: i.currency });
  if (i.tickSize) second.push({ title: "Tick size", value: i.tickSize });
  return [first, second];
}

export type SessionPart = "pre" | "open" | "post";
export type SessionSegment = { part: SessionPart; from: number; to: number };
export type SessionDay = { weekday: string; day: number; today: boolean; segments: SessionSegment[] };

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** The trading parts of local day `day` in minutes after the exchange midnight (0..1440): the extended session's
 *  intervals split around the regular ones. */
export function dayParts(regular: SessionSpec, extended: SessionSpec | null, day: number): SessionSegment[] {
  const tz = regular.timeZone;
  const midnight = localToUtc(tz, day, 0);
  const mins = (sec: number) => Math.max(0, Math.min(1440, Math.round((sec - midnight) / 60)));
  const reg = regular.dayIntervals(day).map((iv) => ({ from: mins(iv.start), to: mins(iv.end) })).filter((r) => r.to > r.from);
  const ext = (extended ?? regular).dayIntervals(day).map((iv) => ({ from: mins(iv.start), to: mins(iv.end) })).filter((r) => r.to > r.from);
  // Outside the regular session: pre-market before its open, post-market after.
  const open = reg.length ? Math.min(...reg.map((r) => r.from)) : 1440;
  const gap = (from: number, to: number): SessionSegment => ({ part: to <= open ? "pre" : "post", from, to });
  const out: SessionSegment[] = [];
  for (const e of ext.length ? ext : reg) {
    let at = e.from;
    for (const r of reg) {
      if (r.to <= at || r.from >= e.to) continue;
      if (r.from > at) out.push(gap(at, r.from));
      out.push({ part: "open", from: Math.max(at, r.from), to: Math.min(e.to, r.to) });
      at = Math.min(e.to, r.to);
    }
    if (at < e.to) out.push(gap(at, e.to));
  }
  return out;
}

/** The days Sunday to Saturday of the week of `nowSec` (exchange time), today marked. */
export function sessionWeek(regular: SessionSpec, extended: SessionSpec | null, nowSec: number): SessionDay[] {
  const today = localDay(regular.timeZone, nowSec);
  // weekdayOf: 1 = Sunday … 7 = Saturday.
  const sunday = today - (weekdayOf(today) - 1);
  return WEEKDAYS.map((weekday, i) => {
    const day = sunday + i;
    return { weekday, day, today: day === today, segments: dayParts(regular, extended, day) };
  });
}

/** "New York" for "America/New_York". */
export function zoneCity(timeZone: string): string {
  return (timeZone.split("/").pop() ?? timeZone).replace(/_/g, " ");
}

/** "09:30" for 570 minutes. */
export function minutesText(m: number): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(m / 60) % 24)}:${pad(m % 60)}`;
}
