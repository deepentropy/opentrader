import { describe, expect, it } from "vitest";
import { emptyScriptScreen, readScriptScreen, scriptScreenStore } from "../script-screen-store";

describe("readScriptScreen", () => {
  it("keeps valid parts, intraday intervals and the calculation settings", () => {
    const s = readScriptScreen({
      indicatorId: "rsi",
      inputs: { length: 21 },
      interval: "15",
      calcInterval: "1D",
      waitClose: true,
      source: { kind: "watchlist", id: "tech" },
      filters: [
        { id: "a", key: "out:plot0", op: "below", value: 30 },
        { id: "b", key: "cond:alert0", op: null },
        { id: "c", key: 3, op: "above" },
      ],
      columns: ["out:plot0", 4],
      sort: { key: "out:plot0", order: "desc" },
    });
    expect(s.interval).toBe("15");
    expect(s.calcInterval).toBe("1D");
    expect(s.waitClose).toBe(true);
    expect(s.source).toEqual({ kind: "watchlist", id: "tech" });
    // A pill not set yet (no operation) is kept; a broken one is dropped.
    expect(s.filters.map((f) => f.id)).toEqual(["a", "b"]);
    expect(s.columns).toEqual(["out:plot0"]);
  });

  it("falls back to the defaults", () => {
    expect(readScriptScreen(null)).toEqual(emptyScriptScreen());
    const s = readScriptScreen({ interval: "7", calcInterval: "2D", source: { kind: "x" } });
    expect(s.interval).toBe("1D");
    expect(s.calcInterval).toBeNull();
    expect(s.source).toEqual(emptyScriptScreen().source);
  });
});

describe("saved screens", () => {
  it("save as, change, save in place, open, delete", () => {
    scriptScreenStore.update(() => ({ ...emptyScriptScreen(), indicatorId: "rsi" }));
    expect(scriptScreenStore.unsaved()).toBe(true);
    expect(scriptScreenStore.save()).toBe(false);
    scriptScreenStore.saveAs("Oversold");
    const id = scriptScreenStore.savedId()!;
    expect(scriptScreenStore.unsaved()).toBe(false);
    scriptScreenStore.update((s) => ({ ...s, interval: "1W" }));
    expect(scriptScreenStore.unsaved()).toBe(true);
    expect(scriptScreenStore.save()).toBe(true);
    expect(scriptScreenStore.current()?.screen.interval).toBe("1W");
    scriptScreenStore.update((s) => ({ ...s, indicatorId: "macd" }));
    scriptScreenStore.open(id);
    expect(scriptScreenStore.screen().indicatorId).toBe("rsi");
    scriptScreenStore.remove(id);
    expect(scriptScreenStore.saved()).toHaveLength(0);
    expect(scriptScreenStore.savedId()).toBeNull();
  });
});
