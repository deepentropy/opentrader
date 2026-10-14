import { describe, expect, it, vi } from "vitest";

const kv = vi.hoisted(() => {
  const store = new Map<string, string>([["ot:hint.seen", "1"]]);
  return { store, subs: new Map<string, () => void>() };
});
vi.mock("../kv", () => ({
  getItem: (k: string) => kv.store.get(k) ?? null,
  setItem: (k: string, v: string) => void kv.store.set(k, v),
  onExternalChange: (k: string, cb: () => void) => {
    kv.subs.set(k, cb);
    return () => kv.subs.delete(k);
  },
}));

import { ZOOM_HINT, hintState, lineToolHint, setLineToolHint } from "../hints";

describe("hintState", () => {
  it("reads the saved dismissed flag", () => {
    expect(hintState("hint.seen").dismissed()).toBe(true);
    expect(hintState(ZOOM_HINT).dismissed()).toBe(false);
  });

  it("dismiss is saved and shared by every caller of the key", () => {
    const a = hintState("hint.once");
    expect(hintState("hint.once")).toBe(a);
    a.dismiss();
    expect(a.dismissed()).toBe(true);
    expect(kv.store.get("ot:hint.once")).toBe("1");
  });

  it("follows a change made by another window", () => {
    const h = hintState("hint.other");
    kv.store.set("ot:hint.other", "1");
    kv.subs.get("ot:hint.other")!();
    expect(h.dismissed()).toBe(true);
    kv.store.delete("ot:hint.other");
    kv.subs.get("ot:hint.other")!();
    expect(h.dismissed()).toBe(false);
  });
});

describe("line-tool hint", () => {
  it("is null until requested", () => {
    expect(lineToolHint()).toBeNull();
    setLineToolHint({ key: "hint.path", text: "Double-click to finish" });
    expect(lineToolHint()).toEqual({ key: "hint.path", text: "Double-click to finish" });
  });
});
