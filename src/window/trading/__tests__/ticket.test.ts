import { describe, expect, it } from "vitest";
import type { TicketDraft } from "../../../data/trading-ui";
import { fmtPnl, fmtPrice, parsePositive, tickDecimals } from "../format";
import { buildTicket, describeTicket, entryPrice, exitPrice } from "../ticket";

const draft = (p: Partial<TicketDraft> = {}): TicketDraft => ({
  symbol: "NASDAQ:AAPL",
  side: "buy",
  orderType: "limit",
  qty: "10",
  limitPrice: "100",
  stopPrice: "",
  tpOn: false,
  takeProfit: "",
  slOn: false,
  stopLoss: "",
  duration: "day",
  outsideRth: false,
  editing: null,
  ...p,
});
const quote = { bid: 99.9, ask: 100.1, last: 100 };

describe("order ticket", () => {
  it("builds a limit order", () => {
    expect(buildTicket(draft(), quote)).toEqual({
      symbol: "NASDAQ:AAPL",
      side: "buy",
      orderType: "limit",
      qty: 10,
      limitPrice: 100,
      stopPrice: null,
      duration: "day",
      outsideRth: false,
      takeProfit: null,
      stopLoss: null,
    });
  });

  it("asks for the missing prices and quantity", () => {
    expect(buildTicket(draft({ qty: "0" }), quote)).toBe("Enter a quantity");
    expect(buildTicket(draft({ limitPrice: "" }), quote)).toBe("Enter a limit price");
    expect(buildTicket(draft({ orderType: "stopLimit", stopPrice: "" }), quote)).toBe("Enter a stop price");
    expect(buildTicket(draft({ tpOn: true }), quote)).toBe("Enter a take profit price");
  });

  it("keeps the exits on the right side of the entry", () => {
    expect(buildTicket(draft({ tpOn: true, takeProfit: "99" }), quote)).toBe("Take profit must be above the entry price");
    expect(buildTicket(draft({ slOn: true, stopLoss: "101" }), quote)).toBe("Stop loss must be below the entry price");
    expect(buildTicket(draft({ side: "sell", tpOn: true, takeProfit: "101" }), quote)).toBe("Take profit must be below the entry price");
    const ok = buildTicket(draft({ tpOn: true, takeProfit: "110", slOn: true, stopLoss: "95" }), quote);
    expect(ok).toMatchObject({ takeProfit: 110, stopLoss: 95 });
  });

  it("sends no exits when modifying an order", () => {
    expect(buildTicket(draft({ editing: "1:5", tpOn: true, takeProfit: "" }), quote)).toMatchObject({ takeProfit: null });
  });

  it("measures market orders from the quote", () => {
    expect(entryPrice(draft({ orderType: "market" }), quote)).toBe(100.1);
    expect(entryPrice(draft({ orderType: "market", side: "sell" }), quote)).toBe(99.9);
    expect(entryPrice(draft({ orderType: "stop", stopPrice: "105" }), quote)).toBe(105);
  });

  it("puts the default exits 75 / 25 ticks away", () => {
    expect(exitPrice(draft(), quote, "tp", 0.01, 2)).toBe("100.75");
    expect(exitPrice(draft(), quote, "sl", 0.01, 2)).toBe("99.75");
    expect(exitPrice(draft({ side: "sell" }), quote, "tp", 0.01, 2)).toBe("99.25");
  });

  it("describes the order on the place button", () => {
    expect(describeTicket(draft(), 2)).toBe("10 AAPL @ 100.00 LIMIT");
    expect(describeTicket(draft({ orderType: "market" }), 2)).toBe("10 AAPL MARKET");
    expect(describeTicket(draft({ orderType: "stopLimit", stopPrice: "101", limitPrice: "101.5" }), 2)).toBe("10 AAPL @ 101.00 STOP 101.50 LIMIT");
  });
});

describe("trading formats", () => {
  it("formats prices and P&L", () => {
    expect(tickDecimals(0.01)).toBe(2);
    expect(tickDecimals(0.0001)).toBe(4);
    expect(fmtPrice(342.9, 0.01)).toBe("342.90");
    expect(fmtPnl(1234.5)).toBe("+1,234.50");
    expect(fmtPnl(-3)).toBe("−3.00");
    expect(parsePositive("1,250.5")).toBe(1250.5);
    expect(parsePositive("-1")).toBeNull();
  });
});
