import { describe, expect, it } from "vitest";
import { anchorPoint } from "../popover";

const rect = { left: 100, right: 180, top: 40, bottom: 74 };

describe("anchorPoint", () => {
  it("puts the popover under the anchor, left edges aligned, by default", () => {
    expect(anchorPoint(rect)).toEqual({ x: 100, y: 74, endX: false, endY: false });
  });

  it("aligns the right edges and keeps the gap", () => {
    expect(anchorPoint(rect, { align: "end", gap: 4 })).toEqual({ x: 180, y: 78, endX: true, endY: false });
  });

  it("opens above the anchor with its bottom edge at the gap", () => {
    expect(anchorPoint(rect, { side: "above", gap: 4 })).toEqual({ x: 100, y: 36, endX: false, endY: true });
  });
});
