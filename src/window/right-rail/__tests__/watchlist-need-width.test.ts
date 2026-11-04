import { describe, expect, it } from "vitest";
import { tableWidth } from "../watchlist/need-width";

describe("watchlist table width", () => {
  it("adds the Symbol minimum, the columns, their gaps, the right padding and the scrollbar", () => {
    // 110 + 3 × 64 + 3 × 4 + 12 + 5
    expect(tableWidth(110, [64, 64, 64])).toBe(331);
    expect(tableWidth(110, [])).toBe(127);
  });
});
