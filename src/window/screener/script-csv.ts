/*
 * "Download results as CSV" of the script screener: the rows shown (filtered
 * and sorted), Symbol then the visible columns, values with full precision.
 */
import { bareTicker, type ScriptColumn, type ScriptRow } from "../../data/script-screen";

const quote = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

export function scriptResultsCsv(rows: readonly ScriptRow[], columns: readonly ScriptColumn[]): string {
  const head = ["Symbol", ...columns.map((c) => c.title)].map(quote).join(",");
  const lines = rows
    .filter((r) => !r.error)
    .map((r) => [bareTicker(r.symbol), ...columns.map((c) => {
      const v = r.cells[c.key]?.value;
      return v === null || v === undefined || !Number.isFinite(v) ? "" : String(v);
    })].map(quote).join(","));
  return [head, ...lines].join("\n") + "\n";
}
