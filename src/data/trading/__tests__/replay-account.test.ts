import { describe, expect, it } from "vitest";
import { ReplayAccount, DEFAULT_REPLAY_SETTINGS } from "../replay-account";
import { DEFAULT_SYMBOL, type Bar } from "../../../backtester/types";
import type { OrderRequest } from "../types";

const DAY = 86400;
const T0 = 1_776_902_400; // 23/04/2026 00:00 UTC
const bar = (i: number, open: number, high: number, low: number, close: number): Bar => ({ time: T0 + i * DAY, open, high, low, close, volume: 1 });

const req = (p: Partial<OrderRequest>): OrderRequest => ({
  symbol: "NASDAQ:QQQ",
  side: "buy",
  type: "market",
  qty: 1,
  limitPrice: null,
  stopPrice: null,
  takeProfit: null,
  stopLoss: null,
  ...p,
});

const account = (close = 651.42) =>
  new ReplayAccount("NASDAQ:QQQ", { ...DEFAULT_SYMBOL, qtyStep: 0.01 }, DEFAULT_REPLAY_SETTINGS, "USD", bar(0, 650, 656.92, 645.52, close));

describe("ReplayAccount", () => {
  it("fills a market order at once at the last price", () => {
    const a = account();
    a.place(req({}));
    expect(a.position()).toMatchObject({ side: "buy", qty: 1, avgPrice: 651.42 });
    expect(a.executions()).toMatchObject([{ side: "buy", qty: 1, price: 651.42, time: T0 }]);
    // Reference: "Market order placed on …" then "Market order executed on …".
    expect(a.takeEvents()).toEqual([
      { kind: "placed", label: "Market", side: "buy", qty: 1, price: null, symbol: "NASDAQ:QQQ" },
      { kind: "executed", label: "Market", side: "buy", qty: 1, price: null, symbol: "NASDAQ:QQQ" },
    ]);
  });

  it("closes the position at the next replayed close (reference: +12.46, +1.91 %)", () => {
    const a = account();
    a.place(req({}));
    a.update(bar(1, 658.51, 664.51, 656.53, 663.88));
    expect(a.position()?.pl).toBeCloseTo(12.46, 6);
    a.closePosition();
    expect(a.position()).toBeNull();
    const r = a.report();
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0].profit).toBeCloseTo(12.46, 6);
    expect(r.trades[0].profitPercent * 100).toBeCloseTo(1.91, 2);
    expect(r.trades[0].entry.signal).toBe("Buy market order");
    expect(r.trades[0].exit.signal).toBe("Close position");
    expect(r.performance.all.netProfit).toBeCloseTo(12.46, 6);
  });

  it("fills a limit order along a later update, at its price", () => {
    const a = account();
    a.place(req({ type: "limit", limitPrice: 640 }));
    expect(a.orders()).toMatchObject([{ kind: "order", type: "limit", limitPrice: 640 }]);
    a.update(bar(1, 650, 655, 641, 645));
    expect(a.position()).toBeNull();
    a.update(bar(2, 645, 646, 638, 642));
    expect(a.position()).toMatchObject({ qty: 1, avgPrice: 640 });
    expect(a.orders()).toEqual([]);
  });

  it("fills a gapped stop at the open", () => {
    const a = account(650);
    a.place(req({ type: "stop", stopPrice: 655 }));
    a.update(bar(1, 660, 662, 659, 661));
    expect(a.position()?.avgPrice).toBe(660);
  });

  it("moves the brackets of an order to the position, and closes it at the take profit", () => {
    const a = account(651.42);
    a.place(req({ type: "limit", limitPrice: 640, takeProfit: 640.75, stopLoss: 639.75 }));
    expect(a.orders().map((o) => o.kind)).toEqual(["order", "tp", "sl"]);
    // Fills at 640 on the way down (open nearer the high: high first), the close stays between the brackets.
    a.update(bar(1, 645, 645.5, 640, 640.5));
    expect(a.position()).toMatchObject({ avgPrice: 640, takeProfit: 640.75, stopLoss: 639.75 });
    expect(a.orders().map((o) => `${o.kind}:${o.parentId}`)).toEqual(["tp:position", "sl:position"]);
    a.update(bar(2, 640.5, 641, 640.2, 640.9));
    expect(a.position()).toBeNull();
    const r = a.report();
    expect(r.trades[0].exit.signal).toBe("Bracket Take Profit");
    expect(r.trades[0].exit.price).toBe(640.75);
    expect(a.orders()).toEqual([]);
  });

  it("position brackets: stop loss closes the whole position", () => {
    const a = account(100);
    a.place(req({ qty: 3 }));
    a.setPositionBrackets(110, 95);
    a.update(bar(1, 99, 100, 94, 96));
    expect(a.position()).toBeNull();
    expect(a.report().trades[0].exit).toMatchObject({ signal: "Bracket Stop Loss", price: 95 });
    expect(a.takeEvents().map((e) => `${e.kind} ${e.label}`)).toEqual(["placed Market", "executed Market", "placed Take Profit", "placed Stop Loss", "executed Stop Loss"]);
  });

  it("stop-limit gapped through its stop fills at the open (reference: stop 702.23, limit 709.25, open 705.29)", () => {
    const a = account(701.53);
    a.place(req({ type: "stopLimit", stopPrice: 702.23, limitPrice: 709.25 }));
    a.update(bar(1, 705.29, 713.15, 703.79, 713.15));
    expect(a.position()?.avgPrice).toBe(705.29);
    expect(a.report().trades[0].entry.signal).toBe("Buy stop-limit order");
  });

  it("stop-limit reached on the way with the limit beyond the stop fills at the stop", () => {
    const a = account(100);
    a.place(req({ type: "stopLimit", stopPrice: 102, limitPrice: 103 }));
    a.update(bar(1, 100.5, 104, 100, 103.5));
    expect(a.position()?.avgPrice).toBe(102);
  });

  it("stop-limit gapped beyond its limit waits for the price to come back", () => {
    const a = account(100);
    a.place(req({ type: "stopLimit", stopPrice: 102, limitPrice: 103 }));
    a.update(bar(1, 105, 106, 103.5, 104));
    expect(a.position()).toBeNull();
    a.update(bar(2, 104, 104.5, 102.5, 103));
    expect(a.position()?.avgPrice).toBe(103);
  });

  it("stop-limit: a limit before the stop works once the stop is reached", () => {
    const a = account(100);
    a.place(req({ type: "stopLimit", stopPrice: 105, limitPrice: 104 }));
    a.update(bar(1, 101, 106, 100.5, 105.5));
    expect(a.position()).toBeNull();
    a.update(bar(2, 105.5, 106, 103.5, 104.5));
    expect(a.position()?.avgPrice).toBe(104);
  });

  it("cancels an order and its brackets", () => {
    const a = account(100);
    const id = a.place(req({ type: "limit", limitPrice: 90, stopLoss: 85 }))!;
    a.takeEvents();
    a.cancel(id);
    expect(a.orders()).toEqual([]);
    expect(a.takeEvents().map((e) => `${e.kind} ${e.label}`)).toEqual(["cancelled Limit", "cancelled Stop Loss"]);
    a.update(bar(1, 95, 96, 80, 82));
    expect(a.position()).toBeNull();
  });

  it("reverses and partially closes the position", () => {
    const a = account(100);
    a.place(req({ qty: 2 }));
    a.reverse();
    expect(a.position()).toMatchObject({ side: "sell", qty: 2 });
    // Reference: one market order of twice the position, "Reverse position order".
    expect(a.executions().slice(-1)[0]).toMatchObject({ side: "sell", qty: 4 });
    expect(a.report().trades[1].entry.signal).toBe("Reverse position order");
    a.closePosition(1);
    expect(a.position()).toMatchObject({ side: "sell", qty: 1 });
    expect(a.report().trades.map((t) => t.exit.signal)).toContain("Close position (partial)");
  });

  it("flatten cancels the orders and closes the position", () => {
    const a = account(100);
    a.place(req({}));
    a.place(req({ type: "limit", limitPrice: 90 }));
    a.flatten();
    expect(a.position()).toBeNull();
    expect(a.orders()).toEqual([]);
    expect(a.hasExecutions).toBe(true);
  });

  it("new settings rebuild the account from the same orders", () => {
    const a = account(100);
    a.place(req({ qty: 10 }));
    a.update(bar(1, 100, 112, 99, 110));
    a.closePosition();
    expect(a.netProfit).toBeCloseTo(100, 6);
    a.applySettings({ ...DEFAULT_REPLAY_SETTINGS, commissionType: "cash_per_order", commissionValue: 5 });
    expect(a.netProfit).toBeCloseTo(90, 6);
    expect(a.takeEvents()).toEqual([]);
    expect(a.report().equity).toHaveLength(2);
  });

  it("settings changed twice keep the orders", () => {
    const a = account(100);
    a.place(req({ qty: 10 }));
    a.update(bar(1, 100, 112, 99, 110));
    a.applySettings({ ...DEFAULT_REPLAY_SETTINGS, commissionType: "cash_per_order", commissionValue: 5 });
    a.applySettings({ ...DEFAULT_REPLAY_SETTINGS, commissionType: "cash_per_order", commissionValue: 1 });
    expect(a.position()?.qty).toBe(10);
  });

  it("a snapshot builds the same account again (saved replay)", () => {
    const a = account(100);
    a.place(req({ qty: 2 }));
    a.place(req({ type: "limit", limitPrice: 95, takeProfit: 99 }));
    a.update(bar(1, 100, 101, 94, 96));
    a.update(bar(2, 96, 100, 95, 99.5));
    const b = ReplayAccount.restore(JSON.parse(JSON.stringify(a.snapshot())));
    expect(b.position()).toEqual(a.position());
    expect(b.orders()).toEqual(a.orders());
    expect(b.executions()).toEqual(a.executions());
    expect(b.netProfit).toBeCloseTo(a.netProfit, 9);
    expect(b.takeEvents()).toEqual([]);
    // It goes on like the original.
    a.update(bar(3, 99.5, 101, 99, 100));
    b.update(bar(3, 99.5, 101, 99, 100));
    expect(b.position()).toEqual(a.position());
  });
});
