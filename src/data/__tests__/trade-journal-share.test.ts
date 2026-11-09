import { describe, expect, it } from "vitest";
import type { JournalTrade } from "../trade-journal";
import { MAX_SHARED_ROWS, shareListSeed, shareTradeSeed, tradeSummary, tradeTable } from "../trade-journal-share";

const NY = "America/New_York";
const T0 = Date.UTC(2026, 10, 3, 14, 30) / 1000; // Tuesday 03/11/2026 09:30 New York

function trade(over: Partial<JournalTrade> = {}, pnlPct = 0.05): JournalTrade {
  return {
    id: "t1",
    symbol: "AAPL",
    fullSymbol: "NASDAQ:AAPL",
    zone: NY,
    side: "long",
    entryTime: T0,
    exitTime: T0 + 2 * 86400 + 3600,
    dateOnly: false,
    qty: 10,
    entryPrice: 200,
    fees: 1.5,
    notes: "Chased the gap, too big",
    status: "ok",
    calc: {
      entryPrice: 200,
      exitPrice: 200 * (1 + pnlPct),
      entryEstimated: false,
      exitEstimated: true,
      pnl: 2000 * pnlPct - 1.5,
      pnlPct,
      runUp: 20,
      runUpPct: 0.1,
      drawdown: 4,
      drawdownPct: 0.02,
      interval: "1",
    },
    ...over,
  };
}

describe("tradeTable", () => {
  it("shows a trade in percent, its dates dd/mm/yyyy and its prices", () => {
    const md = tradeTable([trade()], { timeZone: NY, amounts: false, symbol: false });
    const [head, sep, row] = md.split("\n");
    expect(head).toBe("| Side | Entry | Entry price | Exit | Exit price | Move | Run-up | Drawdown | Duration |");
    expect(sep).toBe("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    expect(row).toBe("| Long | 03/11/2026 09:30 | 200.00 | 05/11/2026 10:30 | 210.00 | +5.00% | 10.00% | 2.00% | 2d 1h |");
  });
  it("adds quantity, P&L and fees only with the amounts", () => {
    const md = tradeTable([trade()], { timeZone: NY, amounts: true, symbol: true });
    expect(md.split("\n")[0]).toMatch(/^\| Symbol \| Side .* \| Qty \| P&L \| Fees \|$/);
    expect(md.split("\n")[2]).toMatch(/^\| AAPL \| Long .* \| 10 \| \+98\.50 \| 1\.50 \|$/);
    expect(tradeTable([trade()], { timeZone: NY, amounts: false, symbol: true })).not.toMatch(/98\.50|Qty|Fees/);
  });
  it("reads a date-only trade's dates in its exchange zone, without a time", () => {
    const day = Date.UTC(2026, 10, 3, 5) / 1000; // midnight New York
    const md = tradeTable([trade({ dateOnly: true, entryTime: day, exitTime: day + 3 * 86400 })], { timeZone: "Asia/Tokyo", amounts: false, symbol: false });
    expect(md.split("\n")[2]).toContain("| 03/11/2026 | 200.00 | 06/11/2026 |");
    expect(md).toContain("| 3d |");
  });
  it("leaves the values of a trade without bars empty", () => {
    const md = tradeTable([trade({ calc: null, status: "nodata", entryPrice: undefined })], { timeZone: NY, amounts: false, symbol: false });
    expect(md.split("\n")[2]).toBe("| Long | 03/11/2026 09:30 | — | 05/11/2026 10:30 | — | — | — | — | 2d 1h |");
  });
});

describe("tradeSummary", () => {
  const list = [trade({ id: "a" }, 0.06), trade({ id: "b" }, -0.02), trade({ id: "c" }, 0.01), trade({ id: "d", calc: null, status: "unknown" })];
  it("counts the trades, the winners, the profit factor and the average move", () => {
    expect(tradeSummary(list, false)).toBe("**4 trades** (1 without values) · 66.7% winners · profit factor 3.50 · average +1.67%");
  });
  it("adds the net P&L with the amounts", () => {
    expect(tradeSummary(list, true)).toMatch(/ · net P&L \+95\.50$/);
  });
  it("has no profit factor without a losing trade", () => {
    expect(tradeSummary([trade()], false)).toBe("**1 trade** · 100.0% winners · profit factor — · average +5.00%");
  });
});

describe("share seeds", () => {
  it("opens one trade as a post-mortem in its ticker, with the chart, and nothing written", () => {
    const s = shareTradeSeed(trade(), NY);
    expect(s).toMatchObject({ type: "postmortem", to: "t:AAPL", attach: true, title: "AAPL long, 03/11/2026 to 05/11/2026" });
    expect(s.body).toBeUndefined();
    expect(s.journal!.table).not.toContain("Qty");
    expect(s.journal!.withAmounts).toContain("Qty");
  });
  it("never copies the journal's notes", () => {
    const one = shareTradeSeed(trade(), NY);
    const many = shareListSeed([trade(), trade({ id: "t2" })], NY, "November 2026");
    for (const text of [one.journal!.table, one.journal!.withAmounts, many.journal!.table, many.journal!.withAmounts]) expect(text).not.toContain("Chased");
  });
  it("posts a list in General with its summary, capped in rows", () => {
    const trades = Array.from({ length: MAX_SHARED_ROWS + 7 }, (_, i) => trade({ id: `t${i}` }));
    const s = shareListSeed(trades, NY, "November 2026");
    expect(s).toMatchObject({ type: "analysis", to: "c:general", title: "Journal, November 2026: 57 trades" });
    expect(s.attach).toBeFalsy();
    const lines = s.journal!.table.split("\n");
    expect(lines[0]).toMatch(/^\*\*57 trades\*\* · 100\.0% winners/);
    expect(lines.filter((l) => l.startsWith("| AAPL "))).toHaveLength(MAX_SHARED_ROWS);
    expect(lines[lines.length - 1]).toBe("*First 50 of 57 trades.*");
  });
});
