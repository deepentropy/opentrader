import { describe, expect, it } from "vitest";
import { defaultLayout, moveInLayout, normalizeLayout, setHiddenInLayout } from "../right-rail-layout";

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
  it("hides a button in its place and shows it there again (#306)", () => {
    const l = defaultLayout(IDS);
    const hidden = setHiddenInLayout(l, "alerts", true);
    expect(hidden).toEqual({ ...l, hidden: ["alerts"] });
    // Moving another button keeps the hidden one hidden, in its place.
    expect(moveInLayout(hidden, "base", "bottom", 0)).toEqual({ top: ["alerts", "object_tree", "trade-journal-button"], bottom: ["base", "pine-dialog-button"], hidden: ["alerts"] });
    expect(setHiddenInLayout(hidden, "alerts", false)).toEqual(l);
    // Saved hidden buttons are kept when known, unknown ones dropped.
    expect(normalizeLayout({ ...l, hidden: ["alerts", "gone"] }, IDS).hidden).toEqual(["alerts"]);
  });
  it("keeps one button shown", () => {
    let l = defaultLayout(IDS);
    for (const id of IDS.slice(0, -1)) l = setHiddenInLayout(l, id, true);
    expect(setHiddenInLayout(l, "pine-dialog-button", true)).toBe(l);
    expect(normalizeLayout({ ...l, hidden: IDS }, IDS).hidden).toBeUndefined();
  });
});
