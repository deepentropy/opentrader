import { describe, expect, it, vi } from "vitest";

/** A computed trade: entry at `day` 15:30 UTC (New York), `pct` move, `pnl` net. */
const trade = (id: string, symbol: string, side: "long" | "short", day: string, pnl: number, pct: number, status = "ok") => ({
  id,
  symbol,
  fullSymbol: `NASDAQ:${symbol}`,
  zone: "America/New_York",
  side,
  entryTime: Date.parse(`${day}T15:30:00Z`) / 1000,
  exitTime: Date.parse(`${day}T19:00:00Z`) / 1000,
  dateOnly: false,
  status,
  calc: status === "ok" ? { entryPrice: 100, exitPrice: 100 * (1 + pct), entryEstimated: false, exitEstimated: false, pnl, pnlPct: pct, runUp: 0, runUpPct: Math.max(pct, 0.01), drawdown: 0, drawdownPct: 0.02, interval: "5" } : null,
});

const journal = vi.hoisted(() => ({ value: null as any, imported: [] as { parsed: any[]; opts: any }[] }));
vi.mock("../../data/trade-journal", () => ({
  tradeJournal: {
    journals: () => [journal.value],
    active: () => journal.value,
    importTrades: (parsed: any[], opts: any) => {
      journal.imported.push({ parsed, opts });
      return Promise.resolve({ id: "j1", added: parsed.length, unknown: [], dropped: 0 });
    },
    setOpen: () => undefined,
  },
}));

import { createJournalTools } from "../journal-tools";
import { attach } from "../../data/assistant/attachments";

journal.value = {
  id: "j1",
  name: "November",
  created: 0,
  trades: [
    trade("a", "AAPL", "long", "2026-11-02", 300, 0.03),
    trade("b", "AAPL", "short", "2026-11-03", -100, -0.01),
    trade("c", "MSFT", "long", "2026-11-03", 50, 0.005),
    trade("d", "MSFT", "long", "2026-11-10", -200, -0.02),
    trade("e", "ZZZZ", "long", "2026-11-10", 0, 0, "unknown"),
  ],
};

const tools = createJournalTools();
const run = (name: string, args: Record<string, unknown> = {}) => tools.find((t) => t.name === name)!.run(args) as Promise<Record<string, any>>;

describe("journal_summary", () => {
  it("sums up the computed trades of the journal shown", async () => {
    const r = await run("journal_summary");
    expect(r).toMatchObject({
      journal: "November",
      trades: 5,
      computed: 4,
      withoutValues: 1,
      winners: 2,
      losers: 2,
      winRate: 0.5,
      netPnl: 50,
      averagePnlPct: 0.0012,
      averageWinPct: 0.0175,
      averageLossPct: -0.015,
      profitFactor: 1.17,
      best: { number: 1, symbol: "NASDAQ:AAPL", pnl: 300, pnlPct: 0.03 },
      worst: { number: 4, symbol: "NASDAQ:MSFT", pnl: -200, pnlPct: -0.02 },
    });
    expect(r.groups).toBeUndefined();
  });

  it("groups by symbol (best first), side, day and week of entry in exchange time", async () => {
    const sym = await run("journal_summary", { by: "symbol" });
    expect(sym.groups.map((g: any) => [g.symbol, g.trades, g.netPnl])).toEqual([
      ["NASDAQ:AAPL", 2, 200],
      ["NASDAQ:ZZZZ", 1, 0],
      ["NASDAQ:MSFT", 2, -150],
    ]);
    const side = await run("journal_summary", { by: "side" });
    expect(side.groups.map((g: any) => [g.side, g.winRate])).toEqual([
      ["long", 0.6667],
      ["short", 0],
    ]);
    const day = await run("journal_summary", { by: "day" });
    expect(day.groups.map((g: any) => g.day)).toEqual(["2026-11-10", "2026-11-03", "2026-11-02"]);
    const week = await run("journal_summary", { by: "week" });
    expect(week.groups.map((g: any) => [g.week, g.netPnl])).toEqual([
      ["week of 2026-11-09", -200],
      ["week of 2026-11-02", 250],
    ]);
  });

  it("refuses an unknown grouping or journal", async () => {
    await expect(run("journal_summary", { by: "hour" })).rejects.toThrow(/by: one of/);
    await expect(run("journal_summary", { name: "December" })).rejects.toThrow(/No journal named/);
  });
});

describe("trade files", () => {
  // A broker export the import dialog can't map alone: its own column names, a separate time column, day-first dates,
  // decimal commas.
  const broker = [
    "Underlying;Dir;T open;Hr1;T close;Hr2;Lots;In;Out",
    "AAPL;B;05/11/2026;09:35;06/11/2026;15:50;10;180,50;185,25",
    "MSFT;S;13/11/2026;10:00;13/11/2026;11:30;5;410,00;405,10",
    "ZZ;B;;;;;1;1;1",
  ].join(String.fromCharCode(10));

  it("reads the columns, first rows and the guessed mapping of an attached file", async () => {
    const f = attach("broker.csv", broker);
    const r = await run("read_trade_file", { file: f.id });
    expect(r).toMatchObject({ name: "broker.csv", rows: 3, columns: ["Underlying", "Dir", "T open", "Hr1", "T close", "Hr2", "Lots", "In", "Out"], decimalComma: true });
    expect(r.firstRows[0]).toMatchObject({ Underlying: "AAPL", In: "180,50" });
    expect(r.mapping).toEqual({ symbol: "Underlying", side: "Dir", qty: "Lots" });
    expect(r.missing).toEqual(["entry", "exit"]);
  });

  it("imports with the mapping the model gives: dates day first (detected), clocks, side, decimal commas", async () => {
    const f = attach("broker.csv", broker);
    const mapping = { entry: "t open", entryClock: "Hr1", exit: "T close", exitClock: "Hr2", entryPrice: "In", exitPrice: "Out" };
    const r = await run("import_trades", { file: f.id, mapping });
    expect(r).toMatchObject({ journal: "November", added: 2, unreadRows: 1 });
    const { parsed, opts } = journal.imported[journal.imported.length - 1];
    expect(opts.name).toBe("broker");
    expect(parsed[0]).toMatchObject({ symbol: "AAPL", side: "long", qty: 10, entryPrice: 180.5, exitPrice: 185.25, entry: { kind: "wall", y: 2026, m: 10, d: 5, h: 9, mi: 35 } });
    expect(parsed[1]).toMatchObject({ symbol: "MSFT", side: "short", entry: { d: 13, h: 10 } });
  });

  it("takes pasted CSV text, and one symbol for a file without a symbol column", async () => {
    const csv = ["Entry Date,Exit Date,Entry Price", "2026-11-02,2026-11-04,250.5", ""].join(String.fromCharCode(10));
    const r = await run("import_trades", { csv, symbol: "tsla", name: "Tesla swings" });
    expect(r.added).toBe(1);
    expect(journal.imported[journal.imported.length - 1].parsed[0]).toMatchObject({ symbol: "TSLA", entryPrice: 250.5, entry: { d: 2 } });
  });

  it("says what is missing or wrong", async () => {
    const f = attach("broker.csv", broker);
    await expect(run("import_trades", { file: f.id })).rejects.toThrow(/No column for entry, exit/);
    await expect(run("import_trades", { file: f.id, mapping: { symbol: "Ticker" } })).rejects.toThrow(/no column "Ticker"; columns: Underlying, Dir/);
    await expect(run("import_trades", { file: f.id, mapping: { price: "In" } })).rejects.toThrow(/unknown field "price"/);
    await expect(run("read_trade_file", { file: "fzzzz" })).rejects.toThrow(/attaches it again/);
    await expect(run("import_trades", { file: f.id, trades: [] })).rejects.toThrow(/not both/);
  });
});
