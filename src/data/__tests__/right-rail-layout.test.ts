import { describe, expect, it } from "vitest";
import { defaultLayout, moveInLayout, normalizeLayout } from "../right-rail-layout";

const IDS = ["base", "alerts", "object_tree", "trade-journal-button", "pine-dialog-button"];

describe("right rail layout", () => {
  it("puts the script editor at the bottom by default", () => {
    expect(defaultLayout(IDS)).toEqual({ top: ["base", "alerts", "object_tree", "trade-journal-button"], bottom: ["pine-dialog-button"] });
  });
  it("fits a saved layout to the buttons of this version", () => {
    const saved = { top: ["alerts", "gone", "base", "alerts"], bottom: ["object_tree"] };
    expect(normalizeLayout(saved, IDS)).toEqual({
      top: ["alerts", "base", "trade-journal-button"],
      bottom: ["object_tree", "pine-dialog-button"],
    });
    expect(normalizeLayout(null, IDS)).toEqual(defaultLayout(IDS));
  });
  it("moves a button within and across groups", () => {
    const l = defaultLayout(IDS);
    expect(moveInLayout(l, "base", "top", 2)).toEqual({ ...l, top: ["alerts", "object_tree", "base", "trade-journal-button"] });
    expect(moveInLayout(l, "alerts", "bottom", 0)).toEqual({ top: ["base", "object_tree", "trade-journal-button"], bottom: ["alerts", "pine-dialog-button"] });
    expect(moveInLayout(l, "pine-dialog-button", "top", 99).top.slice(-1)).toEqual(["pine-dialog-button"]);
  });
});
