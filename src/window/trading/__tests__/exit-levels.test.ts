import { describe, expect, it } from "vitest";
import { addDraftLevel, levelsOf, levelsRiskReward, protectedPct } from "../exit-levels";

describe("exit levels of the ticket (#330)", () => {
  const two = [
    { qty: "5", tp: "110", sl: "95" },
    { qty: "5", tp: "120", sl: "90" },
  ];

  it("reads the levels typed, each with both exits on its side of the entry, at most the order's quantity", () => {
    expect(levelsOf(two, 10, 100, "buy")).toEqual([
      { qty: 5, takeProfit: 110, stopLoss: 95 },
      { qty: 5, takeProfit: 120, stopLoss: 90 },
    ]);
    expect(levelsOf([{ qty: "5", tp: "", sl: "95" }], 10, 100, "buy")).toMatch(/Level 1/);
    expect(levelsOf(two, 10, 100, "sell")).toMatch(/Level 1/);
    expect(levelsOf(two, 8, 100, "buy")).toMatch(/more than/);
  });

  it("gives the protected size and the risk / reward of the levels together", () => {
    expect(protectedPct(two, 10)).toBe(100);
    expect(protectedPct(two.slice(0, 1), 10)).toBe(50);
    // Rewards 5 * 10 + 5 * 20, risks 5 * 5 + 5 * 10.
    expect(levelsRiskReward(two, 100)).toBe(2);
  });

  it("adds a level at the default distances on the part left (the exits as the first level)", () => {
    expect(addDraftLevel([], { tp: 110, sl: null }, 10, 100, "buy", 0.1, 1, 2)).toEqual([
      { qty: "5", tp: "110.00", sl: "97.50" },
      { qty: "5", tp: "107.50", sl: "97.50" },
    ]);
    expect(addDraftLevel([{ qty: "4", tp: "110", sl: "95" }], { tp: null, sl: null }, 10, 100, "sell", 0.1, 1, 2)).toEqual([
      { qty: "4", tp: "110.00", sl: "95.00" },
      { qty: "6", tp: "92.50", sl: "102.50" },
    ]);
    expect(addDraftLevel([], { tp: 110, sl: 95 }, 1, 100, "buy", 0.1, 1, 2)).toBeNull();
  });
});
