import { describe, expect, it } from "vitest";
import { applyDepth } from "../depth-book";

describe("applyDepth", () => {
  it("a snapshot replaces the book; an update merges, 0 removes a level", () => {
    let b = applyDepth(undefined, { snapshot: true, bids: [{ price: 1.1, qty: 5 }, { price: 1.09, qty: 3 }], asks: [{ price: 1.11, qty: 2 }] });
    expect([...b.bids]).toEqual([[1.1, 5], [1.09, 3]]);
    const before = b;
    b = applyDepth(b, { snapshot: false, bids: [{ price: 1.1, qty: 0 }, { price: 1.08, qty: 7 }], asks: [{ price: 1.11, qty: 4 }] });
    expect([...b.bids]).toEqual([[1.09, 3], [1.08, 7]]);
    expect([...b.asks]).toEqual([[1.11, 4]]);
    expect([...before.bids]).toEqual([[1.1, 5], [1.09, 3]]);
    b = applyDepth(b, { bids: [{ price: 1.2, qty: 1 }] });
    expect([...b.bids]).toEqual([[1.2, 1]]);
    expect(b.asks.size).toBe(0);
  });

  it("skips levels without a valid price or quantity", () => {
    const b = applyDepth(undefined, { bids: [{ price: null, qty: 1 }, { price: 0, qty: 1 }, { price: 2, qty: null }, { price: 3, qty: 1 }] });
    expect([...b.bids]).toEqual([[3, 1]]);
  });
});
