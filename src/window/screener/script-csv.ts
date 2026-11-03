/*
 * "Download results as CSV" of the script screener, in the stock screener's format (./screener-csv): the rows shown
 * (filtered and sorted), Symbol and Description, then the visible columns; values at full precision, no line end
 * after the last row.
 */
import { bareTicker, type ScriptColumn, type ScriptRow } from "../../data/script-screen";
import { csvField } from "./screener-csv";

export function scriptResultsCsv(rows: readonly ScriptRow[], columns: readonly ScriptColumn[], names: ReadonlyMap<string, string>): string {
  const head = ["Symbol", "Description", ...columns.map((c) => c.title)].map(csvField).join(",");
  const lines = rows
    .filter((r) => !r.error)
    .map((r) => {
      const t = bareTicker(r.symbol);
      const values = columns.map((c) => {
        const v = r.cells[c.key]?.value;
        return v === null || v === undefined || !Number.isFinite(v) ? "" : String(v);
      });
      return [t, names.get(t) ?? "", ...values].map(csvField).join(",");
    });
  return [head, ...lines].join("\n");
}
