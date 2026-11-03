import { describe, expect, it } from "vitest";
import { alertStore } from "../alert-store";

describe("alert Clone", () => {
  it("adds a paused copy marked cloned, cleared when restarted", () => {
    const id = alertStore.add({
      symbol: "NASDAQ:AAPL",
      resolution: "1D",
      left: { kind: "price" },
      op: "crossing",
      right: { kind: "value", value: 200 },
      frequency: "only_once",
      name: "Mine",
      message: "",
      sound: "",
      popup: false,
      expiresAt: null,
    });
    const copyId = alertStore.clone(id)!;
    const copy = alertStore.rules().find((r) => r.id === copyId)!;
    expect(copy).toMatchObject({ symbol: "NASDAQ:AAPL", name: "Mine", enabled: false, cloned: true, stopReason: "manual" });
    expect(alertStore.rules().find((r) => r.id === id)!.enabled).toBe(true);
    alertStore.setEnabled(copyId, true);
    expect(alertStore.rules().find((r) => r.id === copyId)!.cloned).toBeUndefined();
  });
});
