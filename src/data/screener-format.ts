/*
 * Stock screener number formats (the reference desktop app 3.4.1 table):
 *   price 14.82 (4 decimals under 1), volume 9.07 M / 810 K / 6 M,
 *   change +6.47% / −1.36% / 0.00%, percent 5.22%, ratio 1.79.
 * Abbreviated values keep up to 2 decimals with trailing zeros removed and a
 * narrow no-break space before the unit letter. Negative numbers use the
 * minus sign U+2212. A missing value is "—".
 */
import type { Fmt } from "./screener-catalog";

export const DASH = "—";
const MINUS = "−";
const NNBSP = " ";

/** 2 decimals, trailing zeros trimmed ("4.80" → "4.8", "6.00" → "6"). */
function trim2(n: number): string {
  return n.toFixed(2).replace(/\.?0+$/, "");
}

/** 9.07 M / 810 K / 1.74 B / 512 (no sign handling). */
function abbrevAbs(a: number): string {
  if (a >= 1e12) return `${trim2(a / 1e12)}${NNBSP}T`;
  if (a >= 1e9) return `${trim2(a / 1e9)}${NNBSP}B`;
  if (a >= 1e6) return `${trim2(a / 1e6)}${NNBSP}M`;
  if (a >= 1e3) return `${trim2(a / 1e3)}${NNBSP}K`;
  return trim2(a);
}

export function abbrev(n: number): string {
  return (n < 0 ? MINUS : "") + abbrevAbs(Math.abs(n));
}

export function priceText(n: number): string {
  const a = Math.abs(n);
  const s = a !== 0 && a < 1 ? a.toFixed(4) : a.toFixed(2);
  return (n < 0 ? MINUS : "") + s;
}

function signed(n: number, body: string): string {
  if (n > 0) return `+${body}`;
  if (n < 0) return `${MINUS}${body}`;
  return body;
}

export type Cell = { text: string; unit?: string; tone?: "up" | "down" };

/** Format one table cell. `currency` is the row currency (unit suffix). */
export function formatCell(fmt: Fmt, v: number | string | null | undefined, currency: string | null): Cell {
  if (v === null || v === undefined || v === "") return { text: DASH };
  if (typeof v === "string") return { text: v };
  if (!Number.isFinite(v)) return { text: DASH };
  const unit = currency ? currency.toUpperCase() : undefined;
  const tone = v > 0 ? "up" : v < 0 ? "down" : undefined;
  switch (fmt) {
    case "price":
      return { text: priceText(v), unit };
    case "signedPrice":
      return { text: signed(v, priceText(Math.abs(v))), unit, tone };
    case "change":
      return { text: signed(v, `${Math.abs(v).toFixed(2)}%`), tone };
    case "percent":
      return { text: `${v < 0 ? MINUS : ""}${Math.abs(v).toFixed(2)}%` };
    case "volume":
      return { text: abbrev(v) };
    case "money":
      return { text: abbrev(v), unit };
    case "number":
      return { text: `${v < 0 ? MINUS : ""}${Math.abs(v).toFixed(2)}` };
    default:
      return { text: String(v) };
  }
}

/** Filter value text (pill value, preset labels): "5", "500 K", "10 B",
 *  "5%", no currency. */
export function valueText(fmt: Fmt, n: number): string {
  switch (fmt) {
    case "volume":
    case "money":
      return abbrev(n);
    case "change":
    case "percent":
      return `${n < 0 ? MINUS : ""}${trim2(Math.abs(n))}%`;
    default:
      return `${n < 0 ? MINUS : ""}${trim2(Math.abs(n))}`;
  }
}

/** Parse a typed filter value; accepts K/M/B/T suffixes and the U+2212 minus. */
export function parseValue(s: string): number | null {
  const t = s.trim().replace(MINUS, "-").replace(/[\s,% ]/g, "");
  if (!t) return null;
  const m = /^(-?\d*\.?\d+)([kmbt])?$/i.exec(t);
  if (!m) return null;
  const mult = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 }[(m[2] ?? "").toLowerCase() as "k"] ?? 1;
  const n = Number(m[1]) * mult;
  return Number.isFinite(n) ? n : null;
}
