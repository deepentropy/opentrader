import { describe, expect, it, vi } from "vitest";

// The kept table state is read through kv, which falls back to localStorage outside the desktop app.
const store = new Map<string, string>();
vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });

const { sortedRows, tableCsv, tradingCsvName, visibleColumns } = await import("../account-table-model");
type Column<T> = import("../account-table-model").Column<T>;

type Row = { sym: string; qty: number | null; note: string };
const cols: Column<Row>[] = [
  { id: "sym", fixed: true, title: () => "Symbol", cell: () => null, value: (r) => r.sym },
  { id: "qty", num: true, title: () => "Quantity", cell: () => null, value: (r) => r.qty },
  { id: "note", title: () => "Note", cell: () => null, value: (r) => r.note },
  { id: "extra", hidden: true, title: () => "Extra", cell: () => null, value: () => "x" },
];
const rows: Row[] = [
  { sym: "B", qty: 2, note: "plain" },
  { sym: "A", qty: null, note: 'with "quote"' },
  { sym: "C", qty: 10, note: "a, b" },
];
const keep = (id: string, state: object) => localStorage.setItem(`ot:trading:table:${id}`, JSON.stringify(state));

describe("account manager tables", () => {
  it("shows the default columns, then the kept choice and order (Symbol first)", () => {
    expect(visibleColumns("t-default", cols).map((c) => c.id)).toEqual(["sym", "qty", "note"]);
    keep("t-kept", { shown: ["note", "extra"], order: ["extra", "note", "qty"] });
    expect(visibleColumns("t-kept", cols).map((c) => c.id)).toEqual(["sym", "extra", "note"]);
  });

  it("sorts ascending and descending, empty values last, and keeps the given order unsorted", () => {
    expect(sortedRows("t-unsorted", cols, rows).map((r) => r.sym)).toEqual(["B", "A", "C"]);
    keep("t-asc", { sort: { id: "qty", dir: "asc" } });
    expect(sortedRows("t-asc", cols, rows).map((r) => r.sym)).toEqual(["B", "C", "A"]);
    keep("t-desc", { sort: { id: "qty", dir: "desc" } });
    expect(sortedRows("t-desc", cols, rows).map((r) => r.sym)).toEqual(["C", "B", "A"]);
  });

  it("writes the shown columns as CSV, quoting commas and quotes", () => {
    keep("t-csv", { sort: { id: "sym", dir: "asc" } });
    expect(tableCsv("t-csv", cols, rows)).toBe(['Symbol,Quantity,Note', 'A,,"with ""quote"""', "B,2,plain", 'C,10,"a, b"'].join("\n"));
  });

  it("names the file after the broker, the tab and the day", () => {
    expect(tradingCsvName("MetaTrader 5", "Trade history", new Date(2026, 10, 13))).toBe("MetaTrader 5-Trade history-2026-11-13.csv");
    expect(tradingCsvName("A/B\\C", "Orders", new Date(2026, 0, 2))).toBe("A_B_C-Orders-2026-01-02.csv");
  });
});
