import { describe, expect, it } from "vitest";
import type { BacktestReport, FilledOrder } from "../../backtester/types";
import { newStrategyFills, strategyFillEvents, strategyFillsBetween } from "../alert-strategy";

const fill = (time: number, id: string, buy: boolean, qty: number, price: number, extra: Partial<FilledOrder> = {}): FilledOrder => ({
  bar: time / 60_000,
  time,
  id,
  comment: id,
  buy,
  entry: true,
  price,
  qty,
  type: "MARKET",
  ...extra,
});
const report = (filledOrders: FilledOrder[]) => ({ filledOrders }) as unknown as BacktestReport;

describe("strategyFillEvents", () => {
  it("gives each fill the position before and after it", () => {
    const ev = strategyFillEvents(report([fill(60_000, "L", true, 0.1, 10), fill(120_000, "L", true, 0.2, 11), fill(180_000, "S", false, 0.6, 12)]));
    expect(ev.map((e) => [e.values.action, e.values.prevPositionSize, e.values.positionSize])).toEqual([
      ["buy", 0, 0.1],
      ["buy", 0.1, 0.3],
      ["sell", 0.3, -0.3],
    ]);
  });

  it("keeps the fill's comment (the id for an order without one) and the alert message the order gave", () => {
    const [e] = strategyFillEvents(report([fill(60_000, "L", true, 1, 10, { comment: "L", alertMessage: "go" })]));
    expect(e.values.comment).toBe("L");
    expect(e.values.alertMessage).toBe("go");
    const [f] = strategyFillEvents(report([fill(60_000, "L", true, 1, 10, { comment: "Long" })]));
    expect(f.values.comment).toBe("Long");
    expect(f.values.alertMessage).toBe("");
  });

  it("names equal fills of one bar apart", () => {
    const ev = strategyFillEvents(report([fill(60_000, "L", true, 1, 10), fill(60_000, "L", true, 1, 10)]));
    expect(new Set(ev.map((e) => e.key)).size).toBe(2);
  });
});

describe("newStrategyFills", () => {
  it("fires nothing on the first reading, then the fills it had not seen", () => {
    const r1 = report([fill(60_000, "L", true, 1, 10)]);
    const first = newStrategyFills(null, r1, 60_000);
    expect(first.fire).toEqual([]);
    const r2 = report([fill(60_000, "L", true, 1, 10), fill(120_000, "S", false, 2, 11)]);
    const second = newStrategyFills(first.state, r2, 0);
    expect(second.fire.map((e) => e.fill.id)).toEqual(["S"]);
    expect(newStrategyFills(second.state, r2, 0).fire).toEqual([]);
  });

  it("ignores fills before the alert's first bar (a longer history loaded later)", () => {
    const first = newStrategyFills(null, report([]), 120_000);
    const more = report([fill(60_000, "L", true, 1, 10), fill(120_000, "S", false, 2, 11)]);
    expect(newStrategyFills(first.state, more, 0).fire.map((e) => e.fill.id)).toEqual(["S"]);
  });
});

describe("strategyFillsBetween", () => {
  it("keeps the fills of the bars in the range", () => {
    const r = report([fill(60_000, "A", true, 1, 10), fill(120_000, "B", false, 1, 11), fill(180_000, "C", true, 1, 12)]);
    expect(strategyFillsBetween(r, 100_000, 180_000).map((e) => e.fill.id)).toEqual(["B"]);
  });
});
