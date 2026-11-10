/*
 * Dates, numbers and durations shown in the interface, written by the interface language (#288): each language gives
 * its locales and chart date patterns in its registry entry (languages.ts). English keeps the app's formats
 * ("Sep 10, 2003", "1,250.5", the chart's "Mon 26 Oct '26"); the call sites keep their Intl options, the language
 * only changes the locale.
 *
 * Not here: prices and values on the chart's scales, which follow the symbol, not the language.
 */
import { activeFormats, translate, translatePlural, translateWith } from "./translator";

const dateFormats = new Map<string, Intl.DateTimeFormat>();
const numberFormats = new Map<string, Intl.NumberFormat>();

/** A date formatter of the interface language, one per (locale, options, zone). */
export function dateFormat(options: Intl.DateTimeFormatOptions, timeZone?: string): Intl.DateTimeFormat {
  const locale = activeFormats().dateLocale;
  const key = `${locale}|${JSON.stringify(options)}|${timeZone ?? ""}`;
  let f = dateFormats.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, timeZone ? { ...options, timeZone } : options);
    dateFormats.set(key, f);
  }
  return f;
}

/** A date written out in the interface language: `dateText(ms, { month: "short", day: "numeric", year: "numeric" })`. */
export function dateText(date: Date | number, options: Intl.DateTimeFormatOptions, timeZone?: string): string {
  return dateFormat(options, timeZone).format(date);
}

/** A number formatter of the interface language, one per (locale, options). */
export function numberFormat(options: Intl.NumberFormatOptions = {}): Intl.NumberFormat {
  const locale = activeFormats().numberLocale;
  const key = `${locale}|${JSON.stringify(options)}`;
  let f = numberFormats.get(key);
  if (!f) {
    f = new Intl.NumberFormat(locale, options);
    numberFormats.set(key, f);
  }
  return f;
}

/** A number in the interface language: `numberText(1250)` → "1,250". */
export function numberText(n: number, options?: Intl.NumberFormatOptions): string {
  return numberFormat(options).format(n);
}

/** The short name of a month (1 to 12): "Oct", 10月. */
export function monthName(month: number, width: "short" | "long" = "short"): string {
  return dateText(Date.UTC(2000, month - 1, 1), { month: width, timeZone: "UTC" });
}

/** Calendar parts of a date, as the chart reads them (`partsOf`). */
export type DateParts = { y: number; m: number; d: number; wd: string };

const pad = (n: number, w: number) => String(n).padStart(w, "0");

/** The short weekday name of the interface language for an English one ("Mon" → 周一). */
function weekdayName(wd: string): string {
  const i = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(wd);
  // 2 January 2000 was a Sunday.
  return i < 0 ? wd : dateText(Date.UTC(2000, 0, 2 + i), { weekday: "short", timeZone: "UTC" });
}

/** A language's date pattern filled with the parts (see `Formats`). */
function fillPattern(pattern: string, p: DateParts): string {
  return pattern.replace(/\{(yyyy|yy|MMM|MM|M|dd|d|wd)\}/g, (_, t: string) => {
    switch (t) {
      case "yyyy": return pad(p.y, 4);
      case "yy": return pad(p.y % 100, 2);
      case "MMM": return monthName(p.m);
      case "MM": return pad(p.m, 2);
      case "M": return String(p.m);
      case "dd": return pad(p.d, 2);
      case "d": return String(p.d);
      default: return weekdayName(p.wd);
    }
  });
}

/** The chart's date label in its default format, with or without the day of the week: "Mon 26 Oct '26". */
export function chartDateText(p: DateParts, withWeekday: boolean): string {
  const f = activeFormats();
  return fillPattern(withWeekday ? f.chartWeekdayDate : f.chartDate, p);
}

/** The short weekday prefix of a chart date label in another format ("Mon 2026-10-26"). */
export function chartWeekday(wd: string): string {
  return weekdayName(wd);
}

/**
 * A lone short month name drawn by a library study (a seasonality table's "Jan") in the interface language. A text
 * rule because the study writes the English name itself; the app's own month names come from `monthName`.
 */
export function libraryMonthRule(dateLocale: string): (text: string) => string {
  const english = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const f = new Intl.DateTimeFormat(dateLocale, { month: "short", timeZone: "UTC" });
  const names = english.map((_, i) => f.format(Date.UTC(2000, i, 1)));
  return (t) => (english.includes(t) ? names[english.indexOf(t)] : t);
}

/** Days, hours and minutes as whole phrases: "2 hours and 28 minutes", "1 day and 3 hours", "less than 1 minute". */
export function durationText(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s - days * 86400) / 3600);
  const minutes = Math.floor((s - days * 86400 - hours * 3600) / 60);
  const day = (n: number) => translatePlural(n, { one: "{0} day", other: "{0} days" });
  const hour = (n: number) => translatePlural(n, { one: "{0} hour", other: "{0} hours" });
  const minute = (n: number) => translatePlural(n, { one: "{0} minute", other: "{0} minutes" });
  if (days === 0 && hours === 0 && minutes === 0) return translateWith("less than 1 minute");
  if (days > 0) return translateWith("{0} and {1}", day(days), hour(hours));
  if (hours > 0) return translateWith("{0} and {1}", hour(hours), minute(minutes));
  return minute(minutes);
}

/** A duration in its largest whole unit: "412 days", "1 day", "2 hours", "1 minute", "< 1 minute". */
export function largestUnitText(ms: number): string {
  const days = Math.floor(ms / 86_400_000);
  if (days > 0) return translatePlural(days, { one: "{0} day", other: "{0} days" }, numberText(days));
  const hours = Math.floor(ms / 3_600_000);
  if (hours > 0) return translatePlural(hours, { one: "{0} hour", other: "{0} hours" }, numberText(hours));
  const minutes = Math.floor(ms / 60_000);
  if (minutes > 0) return translatePlural(minutes, { one: "{0} minute", other: "{0} minutes" }, numberText(minutes));
  return translate("< 1 minute");
}
