/*
 * "Download results as CSV" of the stock screener, as the reference app writes it: every row of the screen (its own
 * scan, up to MAX_ROWS, in the screen's sort), Symbol and Description, then the visible columns in table order
 * titled with their parameters ("Price change %, 1 day"), each price or money column followed by its currency
 * ("Price - Currency"). Raw values at full precision, no thousands or K/M/B; a text with a comma or a quote is quoted;
 * LF line ends, no BOM, no line end after the last row. File: "<screen name>_<yyyy-mm-dd>.csv".
 */
import type { ScanRow } from "../../bindings";
import { COLUMN_BY_ID, configuredLong, type ColumnRef } from "../../data/screener-catalog";

export const MAX_ROWS = 30_000;

const MONEY = new Set(["price", "signedPrice", "money"]);

export const csvField = (s: string): string => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** CSV text of scan rows: `fields` the request's field ids (the visible columns first, then description / currency). */
export function screenCsv(rows: readonly ScanRow[], columns: readonly ColumnRef[], fields: readonly string[]): string {
  const at = (f: string) => fields.indexOf(f);
  const desc = at("description");
  const cur = at("currency");
  const head = ["Symbol", "Description"];
  for (const c of columns) {
    const title = configuredLong(c);
    head.push(title);
    if (MONEY.has(COLUMN_BY_ID[c.id]?.fmt ?? "")) head.push(`${title} - Currency`);
  }
  const lines = rows.map((r) => {
    const out = [r.s, desc >= 0 && typeof r.d[desc] === "string" ? (r.d[desc] as string) : ""];
    const currency = cur >= 0 && typeof r.d[cur] === "string" ? (r.d[cur] as string).toUpperCase() : "";
    columns.forEach((c, i) => {
      const def = COLUMN_BY_ID[c.id];
      const v = r.d[i];
      out.push(v === null || v === undefined ? "" : typeof v === "string" ? (def?.cellText ? def.cellText(v) : v) : String(v));
      if (MONEY.has(def?.fmt ?? "")) out.push(v === null || v === undefined ? "" : currency);
    });
    return out.map(csvField).join(",");
  });
  return [head.map(csvField).join(","), ...lines].join("\n");
}

/** "<name>_<yyyy-mm-dd>.csv" (the local date), the characters a file name cannot hold replaced. */
export function csvFileName(name: string, now = new Date()): string {
  const d = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return `${name.replace(/[\\/:*?"<>|]/g, "_")}_${d}.csv`;
}

/** Save a text file through the browser download (as the app's other exports). */
export function downloadText(name: string, text: string): void {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}
