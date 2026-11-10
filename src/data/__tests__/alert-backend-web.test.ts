import { afterAll, describe, expect, it, vi } from "vitest";
import type { AlertRule } from "../alert-store";
import type { SymbolSession } from "../../bindings";

// The web build: no app shell, the engine runs in the page.
const mocks = vi.hoisted(() => ({
  kv: new Map<string, string>(),
  rules: [] as unknown[],
  sessions: new Map<string, unknown>(),
  minuteBars: [] as unknown[],
  tick: null as ((t: unknown) => void) | null,
}));

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("../../bindings", () => ({
  commands: {
    getSymbolSession: vi.fn(),
    getMinuteHistory: vi.fn(async () => ({ status: "ok", data: { bars: mocks.minuteBars, partial: false } })),
  },
}));
vi.mock("../kv", () => ({
  getItem: (k: string) => mocks.kv.get(k) ?? null,
  setItem: (k: string, v: string) => void mocks.kv.set(k, v),
  removeItem: (k: string) => void mocks.kv.delete(k),
  onExternalChange: () => () => undefined,
}));
vi.mock("../datafeed", () => ({
  onTradeTick: async (cb: (t: unknown) => void) => {
    mocks.tick = cb;
    return () => {};
  },
}));
vi.mock("../providers", () => ({ defaultExchange: () => "NASDAQ" }));
vi.mock("../alert-store", () => ({
  alertStore: { enabledRules: () => mocks.rules, rules: () => mocks.rules, rule: (id: string) => (mocks.rules as AlertRule[]).find((r) => r.id === id) },
}));
vi.mock("../../window/drawings/persistence", () => ({ loadDrawings: () => [] }));
vi.mock("../session", async (orig) => ({ ...(await orig<typeof import("../session")>()), cachedSymbolSessions: (s: string) => mocks.sessions.get(s) ?? null }));

import { SymbolSessions } from "../session";
import { previousRunQuotes, startAlertBackend, type BackendFire } from "../alert-backend";

const usStock: SymbolSession = {
  timezone: "America/New_York",
  session: "0930-1600",
  subsessions: [
    { id: "regular", description: "Regular Trading Hours", session: "0930-1600", corrections: "" },
    { id: "extended", description: "Extended Trading Hours", session: "0400-2000", corrections: "" },
  ],
  holidays: "",
  corrections: "",
  pricescale: 100,
  minmov: 1,
  variableTickSize: "",
} as SymbolSession;

const sec = (...a: [number, number, number, number?, number?]) => Date.UTC(...a) / 1000;
const minute = (time: number, price: number) => ({ time, open: price, high: price, low: price, close: price, volume: 1 });

afterAll(() => vi.useRealTimers());

describe("web build: the bars missed between two visits", () => {
  it("replays them from the last quote kept, and keeps this visit's last quotes", async () => {
    // The previous visit's last quote: 14/10/2026 at 11:00 New York time.
    const previous = sec(2026, 9, 14, 15);
    mocks.kv.set("alerts.last-quotes.v1", JSON.stringify({ "NASDAQ:TLRY": previous }));
    mocks.sessions.set("NASDAQ:TLRY", new SymbolSessions(usStock));
    mocks.rules = [
      {
        id: "r1", symbol: "NASDAQ:TLRY", resolution: "1D", left: { kind: "price" }, op: "crossing_up", right: { kind: "value", value: 500 },
        frequency: "only_once", name: "", message: "", sound: "", popup: false, enabled: true, createdAt: 0, activeSince: Date.UTC(2026, 9, 13), expiresAt: null,
      } satisfies AlertRule,
    ];
    // Crossed while the page was closed: 15/10/2026, 10:00 and 10:01 New York time.
    mocks.minuteBars = [minute(sec(2026, 9, 15, 14, 0), 490), minute(sec(2026, 9, 15, 14, 1), 510)];
    vi.useFakeTimers({ now: Date.UTC(2026, 9, 15, 16), toFake: ["Date", "setInterval", "setTimeout"] });

    const fires: BackendFire[] = [];
    startAlertBackend((f) => fires.push(f), "main");
    // The rules are handed over by the 5 s timer here (effects do not run in the test's server build of Solid).
    await vi.advanceTimersByTimeAsync(5000);
    expect(await previousRunQuotes()).toEqual({ "NASDAQ:TLRY": previous });
    expect(fires).toHaveLength(1);
    expect(fires[0]).toMatchObject({ price: 510, offline: true, fireTime: sec(2026, 9, 15, 14, 1) * 1000 });

    // A quote of this visit: kept once the pace allows, over the previous visit's.
    vi.setSystemTime(Date.UTC(2026, 9, 15, 16, 1));
    mocks.tick!({ symbol: "NASDAQ:TLRY", price: 511, tradePrice: null, tradeTime: null });
    expect(JSON.parse(mocks.kv.get("alerts.last-quotes.v1")!)).toEqual({ "NASDAQ:TLRY": sec(2026, 9, 15, 16, 1) });
  });
});
