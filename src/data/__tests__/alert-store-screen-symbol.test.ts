import { describe, expect, it, vi } from "vitest";

const screenRule = (id: string, symbol: string) => ({
  id,
  symbol,
  resolution: "",
  left: { kind: "screen", screenId: "scr_1", title: "Oversold" },
  op: "screen_enter",
  right: { kind: "value", value: 0 },
  frequency: "every_time",
  name: "",
  message: "",
  sound: "",
  popup: false,
  enabled: true,
  createdAt: 1,
  expiresAt: null,
});
const kv = vi.hoisted(() => ({ store: new Map<string, string>() }));
const lookups = vi.hoisted(() => ({ asked: [] as string[] }));
vi.mock("../kv", () => ({
  getItem: (k: string) => kv.store.get(k) ?? null,
  setItem: (k: string, v: string) => void kv.store.set(k, v),
  removeItem: (k: string) => void kv.store.delete(k),
  onExternalChange: () => () => undefined,
}));
vi.mock("../datafeed", () => ({
  isFullSymbol: (s: string) => s.includes(":"),
  toFullSymbol: (s: string) => {
    lookups.asked.push(s);
    return Promise.resolve(`NASDAQ:${s}`);
  },
}));

describe("screen alerts keep their empty symbol", () => {
  it("is not looked up as a bare ticker, and one given an exchange gets it back", async () => {
    kv.store.set("ot:alerts:v1", JSON.stringify([screenRule("a", ""), screenRule("b", "NASDAQ:")]));
    const { alertStore } = await import("../alert-store");
    await new Promise((r) => setTimeout(r, 0));
    expect(lookups.asked).toEqual([]);
    expect(alertStore.rule("a")?.symbol).toBe("");
    expect(alertStore.rule("b")?.symbol).toBe("");
  });
});
