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
