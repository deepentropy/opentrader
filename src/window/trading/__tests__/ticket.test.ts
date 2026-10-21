import { describe, expect, it } from "vitest";
import type { TicketDraft } from "../../../data/trading/trading-ui";
import { fmtPnl, fmtPrice, parsePositive, tickDecimals } from "../format";
import {
  buildTicket,
  describeTicket,
  entryPrice,
  exitFromValue,
  exitPrice,
  exitTicks,
  exitTypeDisabled,
  exitValueIn,
  fmtTypeValue,
  marketHint,
  parseSigned,
  presetPriceText,
  priceOffset,
  qtyValueIn,
  resolveDraft,
  riskReward,
  riskValue,
  unitsForRisk,
} from "../ticket";
import { presetLines } from "../OrderPresets";

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
  editing: null,
  paneId: null,
  ...p,
});
const quote = { bid: 99.9, ask: 100.1, last: 100 };

describe("order ticket", () => {
  it("builds a limit order", () => {
    expect(buildTicket(draft(), quote)).toEqual({
      symbol: "NASDAQ:AAPL",
      side: "buy",
      type: "limit",
      qty: 10,
      limitPrice: 100,
      stopPrice: null,
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

  it("keeps the exits of an order being modified", () => {
    expect(buildTicket(draft({ editing: "5", tpOn: true, takeProfit: "104" }), quote)).toMatchObject({ takeProfit: 104 });
  });

  it("hints the distance to the market and the risk (reference: Ask − 2388, 0.25 USD risk, R/R 3)", () => {
    const q = { bid: 663.88, ask: 663.88, last: 663.88 };
    const d = draft({ qty: "1", limitPrice: "640.00", tpOn: true, takeProfit: "640.75", slOn: true, stopLoss: "639.75" });
    expect(marketHint(d, q, d.limitPrice, 0.01)).toBe("Ask − 2388");
    expect(marketHint(d, q, "663.88", 0.01)).toBe("Ask");
    expect(marketHint(draft({ side: "sell" }), q, "664", 0.01)).toBe("Bid + 12");
    expect(riskValue(d, q)).toBeCloseTo(0.25, 9);
    expect(riskValue(draft({ slOn: false }), q)).toBeNull();
    expect(riskReward(d, q)).toBeCloseTo(3, 9);
    expect(exitTicks(d, q, d.takeProfit, 0.01)).toBe(75);
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

describe("order ticket field types (reference: QQQ at 717.12, TP 75 / SL 25 ticks)", () => {
  const q = { bid: 717.12, ask: 717.12, last: 717.12 };
  const c = { tick: 0.01, decimals: 2, balance: 100_000 };
  const base = draft({ symbol: "NASDAQ:QQQ", qty: "1", limitPrice: "717.12" });

  it("converts an exit price into ticks, % price, money and % balance", () => {
    expect(exitValueIn("ticks", 717.87, 717.12, 1, c)).toBe(75);
    expect(fmtTypeValue("pricePct", exitValueIn("pricePct", 717.87, 717.12, 1, c)!, 2)).toBe("0.10");
    expect(fmtTypeValue("cash", exitValueIn("cash", 717.87, 717.12, 1, c)!, 2)).toBe("0.75");
    expect(fmtTypeValue("balancePct", exitValueIn("balancePct", 717.87, 717.12, 1, c)!, 2)).toBe("0.00");
    expect(exitValueIn("cash", 717.87, 717.12, null, c)).toBeNull();
  });

  it("turns a typed exit into a price on its side of the entry", () => {
    expect(exitFromValue("tp", "buy", "ticks", 75, 717.12, 1, c)).toBeCloseTo(717.87, 9);
    expect(exitFromValue("sl", "buy", "ticks", 25, 717.12, 1, c)).toBeCloseTo(716.87, 9);
    expect(exitFromValue("tp", "sell", "cash", 0.75, 717.12, 1, c)).toBeCloseTo(716.37, 9);
    expect(exitFromValue("sl", "sell", "pricePct", 1, 700, 1, c)).toBeCloseTo(707, 9);
    expect(exitFromValue("tp", "buy", "balancePct", 0.01, 700, 10, c)).toBeCloseTo(701, 9);
  });

  it("resolves a price offset from the ask / bid and a stop limit from its stop", () => {
    expect(parseSigned("")).toBe(0);
    expect(parseSigned("-5")).toBe(-5);
    expect(parseSigned("5x")).toBeNull();
    expect(resolveDraft({ ...base, limitMode: "offset", limitOffset: "5" }, q, c).limitPrice).toBe("717.17");
    expect(resolveDraft({ ...base, side: "sell", limitMode: "offset", limitOffset: "-5" }, q, c).limitPrice).toBe("717.07");
    const sl = resolveDraft({ ...base, orderType: "stopLimit", stopPrice: "720", limitMode: "offset", limitOffset: "3" }, q, c);
    expect(sl.limitPrice).toBe("720.03");
    expect(marketHint(sl, q, sl.limitPrice, 0.01, "limitPrice")).toBe("Stop + 3");
    expect(priceOffset({ ...base, limitPrice: "717.17" }, q, "limitPrice", 0.01)).toBe(5);
  });

  it("sizes the order by its risk to the stop loss (Risk USD 0.25 → 1 unit)", () => {
    const d = { ...base, qtyType: "riskUsd" as const, risk: "0.25", slOn: true, stopLoss: "716.87" };
    expect(resolveDraft(d, q, c).qty).toBe("1");
    expect(resolveDraft({ ...d, risk: "1" }, q, c).qty).toBe("4");
    expect(resolveDraft({ ...d, risk: "0.1" }, q, c).qty).toBe("0");
    expect(resolveDraft({ ...d, slOn: false }, q, c).qty).toBe("");
    expect(resolveDraft({ ...d, qtyType: "riskPct", risk: "0.01" }, q, c).qty).toBe("40");
    expect(unitsForRisk(10, 100, 100)).toBeNull();
    const r = resolveDraft({ ...base, slOn: true, stopLoss: "716.87" }, q, c);
    expect(qtyValueIn("riskUsd", r, q, c)).toBeCloseTo(0.25, 9);
    expect(qtyValueIn("riskUsd", resolveDraft(base, q, c), q, c)).toBeNull();
  });

  it("resolves exits typed in ticks / money with the quantity", () => {
    const d = { ...base, qty: "2", tpOn: true, tpType: "ticks" as const, tpValue: "75", slOn: true, slType: "cash" as const, slValue: "0.5" };
    const r = resolveDraft(d, q, c);
    expect(r.takeProfit).toBe("717.87");
    expect(r.stopLoss).toBe("716.87");
    expect(riskReward(r, q)).toBeCloseTo(3, 9);
    expect(buildTicket(r, q)).toMatchObject({ qty: 2, takeProfit: 717.87, stopLoss: 716.87 });
  });

  it("allows no money stop loss while the quantity is a risk", () => {
    expect(exitTypeDisabled("sl", "cash", "riskUsd")).toBe(true);
    expect(exitTypeDisabled("sl", "ticks", "riskUsd")).toBe(false);
    expect(exitTypeDisabled("tp", "cash", "riskUsd")).toBe(false);
    expect(exitTypeDisabled("sl", "balancePct", "units")).toBe(false);
  });

  it("describes an order preset", () => {
    expect(presetPriceText("Sell Bid", -5)).toBe("Sell Bid – 5");
    expect(presetPriceText("Buy Ask", 5)).toBe("Buy Ask + 5");
    expect(presetPriceText("Buy Ask", 0)).toBe("Buy Ask");
    expect(presetLines({ orderType: "limit", buyPrice: 5, sellPrice: -5 })).toEqual({ type: "Limit order", prices: ["Sell Bid – 5  Buy Ask + 5"], exits: null });
    expect(presetLines({ orderType: "market", tpPrice: 75, tpPriceType: "ticks", slPrice: 1, slPriceType: "balancePct" })).toEqual({
      type: "Market order",
      prices: null,
      exits: "Exits: TP 75  SL 1 % balance",
    });
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
