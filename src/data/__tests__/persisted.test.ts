import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
const subs = new Map<string, (raw: string | null) => void>();
vi.mock("../kv", () => ({
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  onExternalChange: (k: string, cb: (raw: string | null) => void) => {
    subs.set(k, cb);
    return () => subs.delete(k);
  },
}));

import { oneOf, persisted } from "../persisted";

/** Another window writes `key` (kv applies it, then tells the owner). */
function remote(key: string, raw: string | null) {
  if (raw === null) store.delete(key);
  else store.set(key, raw);
  subs.get(key)?.(raw);
}

beforeEach(() => {
  store.clear();
  subs.clear();
});

describe("persisted", () => {
  it("starts from the default when nothing is stored", () => {
    const [get] = persisted("ot:t:a", { parse: oneOf("x", "y"), format: String, default: "x" });
    expect(get()).toBe("x");
  });

  it("reads a stored value and saves each set in its own format", () => {
    store.set("ot:t:b", "y");
    const [get, set] = persisted("ot:t:b", { parse: oneOf("x", "y"), format: String, default: "x" });
    expect(get()).toBe("y");
    set("x");
    expect(get()).toBe("x");
    expect(store.get("ot:t:b")).toBe("x");
  });

  it("stores JSON by default and falls back to the default on bad or invalid data", () => {
    const parse = (raw: string) => {
      const v = JSON.parse(raw) as { n?: unknown };
      return typeof v.n === "number" ? { n: v.n } : undefined;
    };
    store.set("ot:t:c", "{not json");
    const [get, set] = persisted("ot:t:c", { parse, default: { n: 0 } });
    expect(get()).toEqual({ n: 0 });
    set({ n: 3 });
    expect(store.get("ot:t:c")).toBe('{"n":3}');
    store.set("ot:t:d", '{"n":"3"}');
    expect(persisted("ot:t:d", { parse, default: { n: 0 } })[0]()).toEqual({ n: 0 });
  });

  it("follows the other windows only when asked", () => {
    const [synced] = persisted("ot:t:e", { parse: oneOf("x", "y"), format: String, default: "x", sync: true });
    const [local] = persisted("ot:t:f", { parse: oneOf("x", "y"), format: String, default: "x" });
    remote("ot:t:e", "y");
    remote("ot:t:f", "y");
    expect(synced()).toBe("y");
    expect(local()).toBe("x");
    remote("ot:t:e", "z");
    expect(synced()).toBe("x");
    remote("ot:t:e", "y");
    remote("ot:t:e", null);
    expect(synced()).toBe("x");
  });
});
