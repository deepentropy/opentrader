import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => new Map<string, string>());
vi.mock("../../../data/kv", () => ({
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  onExternalChange: () => () => {},
}));

import {
  LAYOUT_SYNC_ITEMS,
  bindLayoutSync,
  defaultLayoutSync,
  layoutSync,
  rememberCrosshair,
  reviveLayoutSync,
  toggleLayoutSync,
  type LayoutSyncKey,
  type LayoutSyncState,
} from "../layout-sync";

beforeEach(() => store.clear());

describe("defaultLayoutSync", () => {
  it("everything off except Crosshair (global default on)", () => {
    expect(defaultLayoutSync()).toEqual({ symbol: false, interval: false, crosshair: true, time: false, dateRange: false });
  });

  it("Crosshair follows the global setting, then the legacy state", () => {
    rememberCrosshair(false);
    expect(store.get("ot:sync-crosshair")).toBe("0");
    expect(defaultLayoutSync().crosshair).toBe(false);
    store.clear();
    store.set("ot:layout-sync", JSON.stringify({ crosshair: false }));
    expect(defaultLayoutSync().crosshair).toBe(false);
    store.set("ot:layout-sync", "{broken");
    expect(defaultLayoutSync().crosshair).toBe(true);
  });
});

describe("reviveLayoutSync", () => {
  it("keeps only boolean fields of known keys", () => {
    expect(reviveLayoutSync({ symbol: true, interval: "yes", time: 1, extra: true, dateRange: true })).toEqual({
      symbol: true, interval: false, crosshair: true, time: false, dateRange: true,
    });
  });

  it("a tab without toggles takes the legacy global state once", () => {
    store.set("ot:layout-sync", JSON.stringify({ symbol: true, crosshair: false }));
    expect(reviveLayoutSync(undefined)).toMatchObject({ symbol: true, crosshair: false });
    store.clear();
    expect(reviveLayoutSync(null)).toEqual(defaultLayoutSync());
  });
});

describe("layoutSync binding", () => {
  it("defaults before App registers, then the registered tab state", () => {
    expect(layoutSync()).toEqual(defaultLayoutSync());
    let state: LayoutSyncState = { ...defaultLayoutSync() };
    const toggle = vi.fn((k: LayoutSyncKey) => { state = { ...state, [k]: !state[k] }; });
    bindLayoutSync(() => state, toggle);
    toggleLayoutSync("symbol");
    expect(toggle).toHaveBeenCalledWith("symbol");
    expect(layoutSync().symbol).toBe(true);
  });

  it("five toggles in menu order", () => {
    expect(LAYOUT_SYNC_ITEMS.map((x) => x.key)).toEqual(["symbol", "interval", "crosshair", "time", "dateRange"]);
  });
});
