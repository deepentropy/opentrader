/*
 * Strategy Tester number / date formats, as the reference app 3.4.1 renders them
 * (.tmp/backtester/design/doc §3.1): thousands ",", 2 decimals for money
 * and percent, 3 for ratios, "+" on signed colored values, U+2212 for
 * negatives, U+202F before the K / M / B suffix, U+2014 when not available.
 */
import { volumeFormat } from "../../data/volume-format";

export const MINUS = "−";
export const NNBSP = " ";
export const DASH = "—";

const nf2 = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nf3 = new Intl.NumberFormat("en-US", { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const nfInt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

function sign(v: number, signed: boolean): string {
  if (v < 0) return MINUS;
  return signed && v > 0 ? "+" : "";
}

/** 133192.13 -> "133,192.13"; signed: "+133,192.13"; negatives always U+2212. */
export function money(v: number | null | undefined, signed = false): string {
  if (v == null || !Number.isFinite(v)) return DASH;
  return sign(v, signed) + nf2.format(Math.abs(v));
}

/** Fraction -> percent: 1.3319 -> "133.19%". */
export function percent(fraction: number | null | undefined, signed = false): string {
  if (fraction == null || !Number.isFinite(fraction)) return DASH;
  const v = fraction * 100;
  return sign(v, signed) + nf2.format(Math.abs(v)) + "%";
}

export function ratio(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return DASH;
  return (v < 0 ? MINUS : "") + nf3.format(Math.abs(v));
}

export function count(v: number): string {
  return nfInt.format(v);
}

/** Duration in its largest whole unit: "412 days", "1 day", "2 hours", "1 minute", "< 1 minute". */
export function durationString(ms: number): string {
  for (const [unit, size] of [["day", 86_400_000], ["hour", 3_600_000], ["minute", 60_000]] as const) {
    const n = Math.floor(ms / size);
    if (n > 0) return `${nfInt.format(n)} ${unit}${n === 1 ? "" : "s"}`;
  }
  return "< 1 minute";
}

/** Capital pill and trade sizes: 100000 -> "100 K", 36683.12 -> "36.68 K",
 *  512.5 -> "512.5" (see volume-format.ts). */
export function compact(v: number): string {
  return volumeFormat(v, 2);
}

/** Tone class of a signed value. */
export function tone(v: number | null | undefined): "" | "is-positive" | "is-negative" {
  if (v == null || !Number.isFinite(v) || v === 0) return "";
  return v > 0 ? "is-positive" : "is-negative";
}

/** One formatter per (options, zone), reused across rows. */
const formatters = new Map<string, Intl.DateTimeFormat>();
export function zoneFormat(locale: string, options: Intl.DateTimeFormatOptions, timeZone: string): Intl.DateTimeFormat {
  const key = `${locale}|${JSON.stringify(options)}|${timeZone}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, { ...options, timeZone });
    formatters.set(key, f);
  }
  return f;
}

/** UNIX ms -> "Sep 8, 2026" (daily and above) or "Sep 8, 2026 09:30"
 *  (intraday), in `timeZone` (the symbol's exchange zone). */
export function tradeDate(ms: number, intraday: boolean, timeZone: string): string {
  const d = new Date(ms);
  const date = zoneFormat("en-US", { month: "short", day: "numeric", year: "numeric" }, timeZone).format(d);
  if (!intraday) return date;
  const time = zoneFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false }, timeZone).format(d);
  return `${date} ${time}`;
}

/** Testing period pill: "Jul 25, 2018 — Sep 29, 2026", in `timeZone`. */
export function dateRange(fromMs: number, toMs: number, timeZone: string): string {
  const f = zoneFormat("en-US", { month: "short", day: "numeric", year: "numeric" }, timeZone);
  return `${f.format(new Date(fromMs))} ${DASH} ${f.format(new Date(toMs))}`;
}
