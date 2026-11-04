import { describe, expect, it, vi } from "vitest";

// The app events reach for `window`: an event target stands in for it.
vi.stubGlobal("window", new EventTarget());
const { withDrawnBefore } = await import("../source-edits");

const drawn = { rsi: { inputs: { length: 14 }, styles: {}, options: { precision: "Default" } } };

describe("undo step of a study on its defaults", () => {
  it("takes the settings the study was drawn with as its before", () => {
    const before = { indicators: ["rsi"], indicatorSettings: undefined };
    const after = { indicators: ["rsi"], indicatorSettings: { rsi: { inputs: { length: 21 } } } };
    expect(withDrawnBefore(before, after, drawn).indicatorSettings?.rsi).toEqual(drawn.rsi);
  });
  it("keeps a before that has its own settings, or a study the chart did not report", () => {
    const before = { indicators: ["rsi"], indicatorSettings: { rsi: { inputs: { length: 9 } } } };
    const after = { indicators: ["rsi"], indicatorSettings: { rsi: { inputs: { length: 21 } } } };
    expect(withDrawnBefore(before, after, drawn)).toBe(before);
    const bare = { indicators: ["rsi"], indicatorSettings: undefined };
    expect(withDrawnBefore(bare, after, {})).toBe(bare);
  });
});
