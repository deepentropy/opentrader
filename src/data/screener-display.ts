/*
 * A screener value as shown with the Screener settings applied: financial
 * amounts (ColumnDef.financial) in the "Convert financials" currency, and the
 * currency unit left out when "Currency" is off. Prices stay in the symbol's
 * own currency, as in the reference app.
 */
import { usdRate } from "./fx-rates";
import type { ColumnDef } from "./screener-catalog";
import { formatCell, type Cell } from "./screener-format";
import { screenerSettings } from "./screener-settings";

/** Value and currency after "Convert financials" (unchanged until the rate is loaded). */
export function convertedValue(def: ColumnDef | undefined, v: number | string | null | undefined, currency: string | null): { v: typeof v; currency: string | null } {
  const to = screenerSettings().currency;
  if (!to || !def?.financial || typeof v !== "number" || (currency ?? "USD").toUpperCase() !== "USD") return { v, currency };
  const rate = usdRate(to);
  return rate === undefined ? { v, currency } : { v: v * rate, currency: to };
}

export function displayCell(def: ColumnDef | undefined, v: number | string | null | undefined, currency: string | null): Cell {
  if (def?.cellText && typeof v === "string" && v) return { text: def.cellText(v) };
  const c = convertedValue(def, v, currency);
  const f = formatCell(def?.fmt ?? "text", c.v, c.currency);
  return screenerSettings().showCurrency ? f : { ...f, unit: undefined };
}
