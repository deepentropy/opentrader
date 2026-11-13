import { localNumber, numberFormat, typedNumber } from "../../i18n/format";
/*
 * Number / time formatting of the trading panel and order ticket, in the interface language's marks ("1 234,50").
 */

const money = () => numberFormat({ minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Decimals of a price step (0.01 → 2). */
export function tickDecimals(tick: number | null | undefined): number | null {
  if (!tick || !Number.isFinite(tick) || tick <= 0) return null;
  const s = String(tick);
  if (s.includes("e-")) return Number(s.split("e-")[1]);
  return s.includes(".") ? s.split(".")[1].length : 0;
}

export function fmtPrice(v: number | null | undefined, tick?: number | null): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const d = tickDecimals(tick) ?? (Math.abs(v) >= 1 ? 2 : 4);
  return localNumber(v.toFixed(Math.max(d, 2)));
}

export function fmtQty(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return localNumber(Number.isInteger(v) ? String(v) : String(Number(v.toFixed(8))));
}

/** Signed P&L: "+12.34" / "−12.34" (true minus). */
export function fmtPnl(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  if (v === 0) return money().format(0);
  return (v > 0 ? "+" : "−") + money().format(Math.abs(v));
}

export function fmtPct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return localNumber((v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(2) + "%");
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "20/10/2026 14:31:05" (local time). */
export function fmtTime(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return "—";
  const d = new Date(ms);
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** An amount of the account's currency: "1 234,50". */
export function fmtMoney(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return money().format(v);
}

/** The colour class of a profit or loss. */
export function pnlClass(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v) || v === 0) return "";
  return v > 0 ? "is-pos" : "is-neg";
}

/** Parse a typed price / quantity; null when not a positive number. Typed in the interface language's marks too
 *  ("1234,5"). */
export function parsePositive(s: string): number | null {
  const v = Number(typedNumber(String(s)).replace(/,/g, "").trim());
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** The ticker of "EXCHANGE:TICKER". */
export function tickerOf(symbol: string): string {
  const i = symbol.indexOf(":");
  return i >= 0 ? symbol.slice(i + 1) : symbol;
}
