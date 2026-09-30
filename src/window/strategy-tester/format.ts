/*
 * Strategy Tester number / date formats, as TradingView 3.4.1 renders them
 * (research/backtester/design/doc §3.1): thousands ",", 2 decimals for money
 * and percent, 3 for ratios, "+" on signed colored values, U+2212 for
 * negatives, U+202F before the K / M / B suffix, U+2014 when not available.
 */
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

/** 100000 -> "100 K", 36683.12 -> "36.68 K" (U+202F before the suffix). */
export function compact(v: number): string {
  const a = Math.abs(v);
  const units: [number, string][] = [[1e9, "B"], [1e6, "M"], [1e3, "K"]];
  for (const [div, s] of units) {
    if (a >= div) {
      const n = Math.round((a / div) * 100) / 100;
      return (v < 0 ? MINUS : "") + String(n) + NNBSP + s;
    }
  }
  return (v < 0 ? MINUS : "") + nf2.format(a);
}

/** Tone class of a signed value. */
export function tone(v: number | null | undefined): "" | "is-positive" | "is-negative" {
  if (v == null || !Number.isFinite(v) || v === 0) return "";
  return v > 0 ? "is-positive" : "is-negative";
}

const dateFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/New_York" });
const timeFmt = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "America/New_York" });

/** UNIX ms -> "Sep 8, 2026" (daily and above) or "Sep 8, 2026 09:30" (intraday). */
export function tradeDate(ms: number, intraday: boolean, timeZone = "America/New_York"): string {
  const d = new Date(ms);
  const date = timeZone === "America/New_York" ? dateFmt.format(d) : new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone }).format(d);
  if (!intraday) return date;
  const time = timeZone === "America/New_York" ? timeFmt.format(d) : new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone }).format(d);
  return `${date} ${time}`;
}

/** Testing period pill: "Jul 25, 2018 — Sep 29, 2026". */
export function dateRange(fromMs: number, toMs: number): string {
  return `${dateFmt.format(new Date(fromMs))} ${DASH} ${dateFmt.format(new Date(toMs))}`;
}
