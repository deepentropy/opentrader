import { describe, expect, it } from "vitest";
import { blocksBrowserMenu } from "../browser-menu";

/** An element whose closest() finds a match only for the given selector part. */
const inside = (part: string | null) =>
  ({ closest: (sel: string) => (part && sel.split(", ").includes(part) ? {} : null) }) as unknown as EventTarget;

describe("web-view right-click menu", () => {
  it("is blocked outside text fields and kept in them", () => {
    expect(blocksBrowserMenu(inside(null))).toBe(true);
    expect(blocksBrowserMenu(inside('input[type="checkbox"]'))).toBe(true);
    expect(blocksBrowserMenu(null)).toBe(true);
    expect(blocksBrowserMenu({} as EventTarget)).toBe(true);
    expect(blocksBrowserMenu(inside("textarea"))).toBe(false);
    expect(blocksBrowserMenu(inside("input:not([type])"))).toBe(false);
    expect(blocksBrowserMenu(inside('[contenteditable="true"]'))).toBe(false);
  });
});
