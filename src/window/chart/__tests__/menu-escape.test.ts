import { beforeAll, describe, expect, it } from "vitest";

// The module listens to mousedown on the document: a plain event target stands for it.
const doc = new EventTarget();
let m: typeof import("../menu-escape");
beforeAll(async () => {
  (globalThis as { document?: unknown }).document = doc;
  m = await import("../menu-escape");
});

describe("Escape after a context menu", () => {
  it("keeps the selection on the Escape that closes the menu and on the next one", () => {
    const closed = m.contextMenuShown();
    expect(m.escapeKeepsSelection()).toBe(true); // closes the menu
    closed();
    expect(m.escapeKeepsSelection()).toBe(true); // the next one
    expect(m.escapeKeepsSelection()).toBe(false); // clears
  });

  it("without a menu, an Escape clears the selection", () => {
    expect(m.escapeKeepsSelection()).toBe(false);
  });

  it("a click between them ends the kept Escape", () => {
    const closed = m.contextMenuShown();
    expect(m.escapeKeepsSelection()).toBe(true);
    closed();
    doc.dispatchEvent(new Event("mousedown"));
    expect(m.escapeKeepsSelection()).toBe(false);
  });

  it("a menu closed with a click does not keep the next Escape", () => {
    const closed = m.contextMenuShown();
    closed();
    closed(); // closing twice counts once
    expect(m.escapeKeepsSelection()).toBe(false);
  });

  it("tells while a menu is shown (a drawing keeps its selection on that Escape only)", () => {
    expect(m.contextMenuOpen()).toBe(false);
    const closed = m.contextMenuShown();
    expect(m.contextMenuOpen()).toBe(true);
    closed();
    expect(m.contextMenuOpen()).toBe(false);
  });
});
