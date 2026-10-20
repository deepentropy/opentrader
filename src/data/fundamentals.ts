/*
 * Company fundamentals — the financial statement items per fiscal quarter /
 * year and the earnings releases of the company behind a symbol, as the
 * backend serves them (`get_fundamentals`). One request per symbol per run
 * while it answers; a failed lookup is asked again on the next call.
 *
 * Read by the Fundamentals metrics (indicators) and the Events → Earnings
 * markers.
 */
import { commands, type Fundamentals } from "../bindings";
import { isTransientError, retryTransient } from "./connection";

export type { Fundamentals, EarningsEvent, FundamentalPeriods } from "../bindings";

const memo = new Map<string, Promise<Fundamentals | null>>();

/** True for the symbols that have company fundamentals (not economic series). */
export function hasFundamentals(symbol: string): boolean {
  return !/^ECONOMICS:/i.test(symbol.trim());
}

/** Fundamentals of `symbol`, or null when the company has none (or they cannot be read). */
export function getFundamentals(symbol: string): Promise<Fundamentals | null> {
  const key = symbol.trim().toUpperCase();
  if (!hasFundamentals(key)) return Promise.resolve(null);
  let p = memo.get(key);
  if (!p) {
    p = retryTransient(async () => {
      const r = await commands.getFundamentals(key);
      if (r.status === "ok") return r.data;
      if (isTransientError(r.error)) throw new Error(r.error);
      return null;
    }).catch(() => null);
    // A lookup that failed is not kept: the next call asks again.
    p.then((f) => { if (!f) memo.delete(key); });
    memo.set(key, p);
  }
  return p;
}

/** Date "YYYY-MM-DD" → Unix seconds at 00:00 UTC (NaN when malformed). */
export function isoDaySec(d: string): number {
  return Date.parse(`${d}T00:00:00Z`) / 1000;
}
