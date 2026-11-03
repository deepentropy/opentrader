import { describe, expect, it } from "vitest";
import { screenerStore } from "../screener-store";

describe("screener screens: Autosave", () => {
  it("saves each change of a saved screen while on, marks it unsaved while off", () => {
    screenerStore.createNew("Autosave test");
    expect(screenerStore.autosave()).toBe(false);
    screenerStore.update((s) => ({ ...s, watchlistId: "w1" }));
    expect(screenerStore.unsaved()).toBe(true);
    screenerStore.setAutosave(true);
    // Switched on: saved at once, then every change.
    expect(screenerStore.unsaved()).toBe(false);
    screenerStore.update((s) => ({ ...s, watchlistId: "w2" }));
    expect(screenerStore.unsaved()).toBe(false);
    expect(screenerStore.saved()?.screen.watchlistId).toBe("w2");
    screenerStore.undo();
    expect(screenerStore.saved()?.screen.watchlistId).toBe("w1");
    screenerStore.setAutosave(false);
    screenerStore.update((s) => ({ ...s, watchlistId: "w3" }));
    expect(screenerStore.unsaved()).toBe(true);
    expect(screenerStore.saved()?.screen.watchlistId).toBe("w1");
  });
});

describe("screener screens: Stock and ETF screeners", () => {
  it("keeps one current screen per screener and lists each one's saved screens", () => {
    screenerStore.setType("stock");
    screenerStore.createNew("Stock one");
    screenerStore.setType("etf");
    expect(screenerStore.type()).toBe("etf");
    expect(screenerStore.screen().type).toBe("etf");
    expect(screenerStore.screen().sort.sortBy.id).toBe("AssetsUnderManagement");
    screenerStore.createNew("ETF one");
    expect(screenerStore.typeScreens().map((s) => s.screen.title)).toContain("ETF one");
    expect(screenerStore.typeScreens().map((s) => s.screen.title)).not.toContain("Stock one");
    screenerStore.setType("stock");
    expect(screenerStore.screen().title).toBe("Stock one");
    // Opening a screen of the other screener switches to it.
    const etf = screenerStore.savedScreens().find((s) => s.screen.title === "ETF one")!;
    screenerStore.open(etf.id);
    expect(screenerStore.type()).toBe("etf");
    screenerStore.setType("stock");
  });
});
