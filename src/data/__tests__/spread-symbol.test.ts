import { describe, expect, it } from "vitest";
import {
  combineSpreadBars,
  evaluateSpread,
  isSpreadSymbol,
  normalizeSpread,
  parseSpread,
  spreadLegs,
  spreadShortName,
} from "../spread-symbol";

const bar = (time: number, open: number, high: number, low: number, close: number, volume: number) => ({ time, open, high, low, close, volume });

describe("formula symbols", () => {
  it("tells a formula from one listing", () => {
    for (const s of ["AAPL/MSFT", "NASDAQ:AAPL/NASDAQ:MSFT", "2*AAPL", "AAPL^2", "(AAPL+MSFT)/2", "1/NASDAQ:AAPL", "NASDAQ:AAPL-5", "aapl - msft"]) {
      expect(isSpreadSymbol(s), s).toBe(true);
    }
    for (const s of ["AAPL", "NASDAQ:AAPL", "NYSE:BAC/PB", "NYSE:BRK.B", "LOCAL:BTC-2", "ECONOMICS:USGDP", "'BAC/PB'", "", "4DS"]) {
      expect(isSpreadSymbol(s), s).toBe(false);
    }
  });

  it("reads operators by precedence, ^ from the right, signs before operands", () => {
    const v = (text: string) => evaluateSpread(parseSpread(text)!, (leg) => ({ A: 2, B: 3 })[leg]);
    expect(v("A+B*2")).toBe(8);
    expect(v("(A+B)*2")).toBe(10);
    expect(v("2^B^2")).toBe(512);
    expect(v("-A+B")).toBe(1);
    expect(v("A/B")).toBeCloseTo(2 / 3);
    expect(v("A/(B-3)")).toBeNaN();
    for (const bad of ["A+", "(A+B", "A B", "A+*B", "'A", "A#B"]) expect(parseSpread(bad), bad).toBeNull();
  });

  it("names legs once, keeps quoted names whole, writes the full form", async () => {
    expect(spreadLegs("(aapl + msft)/2 - AAPL")).toEqual(["AAPL", "MSFT"]);
    expect(spreadLegs("'NYSE:BAC/PB'/NYSE:BAC")).toEqual(["NYSE:BAC/PB", "NYSE:BAC"]);
    const full = (leg: string) => Promise.resolve(leg.includes(":") ? leg : `NASDAQ:${leg}`);
    expect(await normalizeSpread("aapl / msft", full)).toBe("NASDAQ:AAPL/NASDAQ:MSFT");
    expect(await normalizeSpread("'NYSE:BAC/PB' - 1", full)).toBe("'NYSE:BAC/PB'-1");
    expect(await normalizeSpread("aapl /", full)).toBeNull();
    expect(await normalizeSpread("aapl/zzz", (l) => (l === "ZZZ" ? Promise.reject(new Error("unknown")) : full(l)))).toBeNull();
    expect(spreadShortName("(NASDAQ:AAPL+NASDAQ:MSFT)/2")).toBe("(AAPL+MSFT)/2");
  });

  // Daily bars of 25/11/2026 read on the reference: AAPL, MSFT and AAPL/MSFT.
  it("applies the formula to each price, high and low the extremes, volume summed", () => {
    const tree = parseSpread("NASDAQ:AAPL/NASDAQ:MSFT")!;
    const [b] = combineSpreadBars(tree, ["NASDAQ:AAPL", "NASDAQ:MSFT"], [
      [bar(1795617000, 353.475, 356.75, 345.13, 355.58, 54285255)],
      [bar(1795617000, 485.23, 493.437, 477.39, 489.93, 26759457)],
    ]);
    expect(b.open).toBeCloseTo(0.7284689734764958, 12);
    expect(b.high).toBeCloseTo(0.7284689734764958, 12);
    expect(b.low).toBeCloseTo(0.7229518842036909, 12);
    expect(b.close).toBeCloseTo(0.7257771518380176, 12);
    expect(b.volume).toBe(81044712);
    const [inv] = combineSpreadBars(parseSpread("1/NASDAQ:AAPL")!, ["NASDAQ:AAPL"], [[bar(1795617000, 353.475, 356.75, 345.13, 355.58, 54285255)]]);
    expect(inv.high).toBeCloseTo(0.002897458928519688, 15);
    expect(inv.low).toBeCloseTo(0.002803083391730904, 15);
  });

  it("takes every leg's times; a leg without a bar counts its last close", () => {
    const tree = parseSpread("A/B")!;
    const out = combineSpreadBars(tree, ["A", "B"], [
      [bar(60, 10, 10, 10, 10, 1), bar(120, 12, 12, 12, 12, 2), bar(180, 14, 14, 14, 14, 3)],
      [bar(0, 1, 1, 1, 1, 5), bar(120, 4, 4, 4, 4, 6)],
    ]);
    // 0: A has no bar yet; 60: B counts its close 1; 180: B counts 4.
    expect(out.map((b) => [b.time, b.close, b.volume])).toEqual([
      [60, 10, 1],
      [120, 3, 8],
      [180, 3.5, 3],
    ]);
  });
});

describe("symbol search with a formula", () => {
  it("looks up the leg under the caret", async () => {
    const { spreadTokenAt } = await import("../spread-symbol");
    expect(spreadTokenAt("AAPL/MS", 7)).toMatchObject({ offset: 5, name: "MS" });
    expect(spreadTokenAt("AAPL/MS", 2)).toMatchObject({ offset: 0, name: "AAPL" });
    expect(spreadTokenAt("AAPL/ ", 6)).toBeNull();
  });

  // Read on the reference: "AAPL" → Reciprocal "1/AAPL" → Division "1/AAPL/" → Exponentiation, Subtraction: nothing.
  it("puts operators in as the reference's buttons do", async () => {
    const { insertOperator } = await import("../spread-symbol");
    const r1 = insertOperator("AAPL", 4, "1/")!;
    expect(r1).toEqual({ text: "1/AAPL", caret: 6 });
    const r2 = insertOperator(r1.text, r1.caret, "/")!;
    expect(r2).toEqual({ text: "1/AAPL/", caret: 7 });
    expect(insertOperator(r2.text, r2.caret, "^")).toBeNull();
    expect(insertOperator(r2.text, r2.caret, "-")).toBeNull();
    expect(insertOperator("", 0, "+")).toBeNull();
  });
});
