import { describe, expect, it } from "vitest";
import { anchorPoint, fittedSide } from "../popover";

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

describe("fittedSide", () => {
  // A button 40 px from the window top, in a window 800 px tall: 36 px of room above, 722 below (gap 4).
  const button = { top: 40, bottom: 74 };

  it("keeps the side asked for when the popover fits there", () => {
    expect(fittedSide(button, { side: "above", gap: 4 }, 30, 800)).toBe("above");
    expect(fittedSide(button, { gap: 4 }, 300, 800)).toBe("below");
  });

  it("opens below when it does not fit above and there is more room below", () => {
    expect(fittedSide(button, { side: "above", gap: 4 }, 300, 800)).toBe("below");
  });

  it("opens above when it does not fit below and there is more room above", () => {
    expect(fittedSide({ top: 700, bottom: 734 }, { gap: 4 }, 300, 800)).toBe("above");
  });

  it("keeps the side asked for when the other side has no more room", () => {
    expect(fittedSide({ top: 420, bottom: 454 }, { side: "above", gap: 4 }, 500, 800)).toBe("above");
  });
});
