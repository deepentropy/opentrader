import { describe, expect, it, vi } from "vitest";
import type { AccountPage } from "../../../bindings";

// The kept table state is read through kv, which falls back to localStorage outside the desktop app.
const store = new Map<string, string>();
vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });

const { brokerPageCsv, pageColumns, pageCount } = await import("../broker-pages");
const { saveState } = await import("../account-table-model");

const holdings: AccountPage = {
  id: "holdings",
  title: "Holdings",
  counter: true,
  tables: [
    {
      id: "main",
      title: null,
      columns: [
        { id: "qty", label: "Quantity", format: "qty", hidden: false },
        { id: "symbol", label: "Symbol", format: "symbol", hidden: false },
        { id: "side", label: "Side", format: "side", hidden: false },
        { id: "pnl", label: "P&L", format: "pnl", hidden: false },
        { id: "isin", label: "ISIN", format: "text", hidden: true },
      ],
      sort: { column: "pnl", asc: false },
      rows: [
        { id: "1", symbol: "TCS", qty: 5, side: "buy", pnl: -12.5, isin: "INE467B01029" },
        { id: "2", symbol: "RELIANCE", qty: 10, side: "SELL", pnl: 120, isin: "INE002A01018" },
        { id: "3", symbol: "INFY", qty: "n/a", side: "other", pnl: null },
      ],
    },
  ],
};

describe("broker pages (#384)", () => {
  it("puts the symbol column first and in view, numbers right, the broker's hidden columns hidden", () => {
    const cols = pageColumns(holdings.tables[0]);
    expect(cols.map((c) => [c.id, !!c.fixed, !!c.num, !!c.hidden, !!c.brokerText])).toEqual([
      ["qty", false, true, false, true],
      ["symbol", true, false, false, true],
      ["side", false, false, false, true],
      ["pnl", false, true, false, true],
      ["isin", false, false, true, true],
    ]);
  });

  it("sorts and exports raw values, sides as words, a text in a number column as it is", () => {
    const cols = pageColumns(holdings.tables[0]);
    const row = holdings.tables[0].rows![1];
    expect(cols.map((c) => c.value(row))).toEqual([10, "RELIANCE", "Sell", 120, "INE002A01018"]);
    expect(cols.map((c) => c.value(holdings.tables[0].rows![2]))).toEqual(["n/a", "INFY", "other", null, null]);
  });

  it("writes the CSV in the broker's sort until the user picks one", () => {
    expect(brokerPageCsv("openalgo", holdings)).toBe(["Symbol,Quantity,Side,P&L", "RELIANCE,10,Sell,120", "TCS,5,Buy,-12.5", "INFY,n/a,other,"].join("\n"));
    // "None" picked by the user: the rows as the broker sent them.
    saveState("plugin:openalgo:holdings:main", { sort: null });
    expect(brokerPageCsv("openalgo", holdings).split("\n")[1]).toBe("TCS,5,Buy,-12.5");
  });

  it("titles each table of a page with several, and counts rows only on a counter page", () => {
    const funds: AccountPage = {
      id: "funds",
      title: "Funds",
      counter: false,
      tables: [
        { id: "eq", title: "Equity", columns: [{ id: "v", label: "Value", format: "money", hidden: false }], sort: null, rows: [{ v: 1 }] },
        { id: "co", title: "Commodity", columns: [{ id: "v", label: "Value", format: "money", hidden: false }], sort: null, rows: [{ v: 2 }] },
      ],
    };
    expect(brokerPageCsv("b", funds)).toBe("Equity\nValue\n1\n\nCommodity\nValue\n2");
    expect([pageCount(holdings), pageCount(funds)]).toEqual([3, 0]);
  });
});
