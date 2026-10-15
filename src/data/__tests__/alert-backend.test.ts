import { describe, expect, it, vi } from "vitest";
import type { AlertRule } from "../alert-store";
import type { SymbolSession } from "../../bindings";

const mocks = vi.hoisted(() => {
  // The backend part runs in the app shell only.
  (globalThis as { window?: unknown }).window = { __TAURI_INTERNALS__: {} };
  return { rules: [] as unknown[], sessions: new Map<string, unknown>() };
});

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("../../bindings", () => ({ commands: { getSymbolSession: vi.fn() } }));
vi.mock("../providers", () => ({ defaultExchange: () => "NASDAQ" }));
vi.mock("../alert-store", () => ({ alertStore: { enabledRules: () => mocks.rules, rules: () => mocks.rules, rule: () => undefined } }));
vi.mock("../../window/drawings/persistence", () => ({ loadDrawings: () => [] }));
vi.mock("../session", async (orig) => ({ ...(await orig<typeof import("../session")>()), cachedSymbolSessions: (s: string) => mocks.sessions.get(s) ?? null }));

import { SymbolSessions } from "../session";
import { compileBackendRules, evaluatedByBackend } from "../alert-backend";

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

function rule(over: Partial<AlertRule>): AlertRule {
  return {
    id: "r1", symbol: "NASDAQ:TLRY", resolution: "1D", left: { kind: "price" }, op: "crossing", right: { kind: "value", value: 500 },
    frequency: "only_once", name: "", message: "", sound: "", popup: false, enabled: true, createdAt: 0, activeSince: Date.UTC(2026, 9, 14) , expiresAt: null,
    ...over,
  };
}
const msft = { kind: "symbol", symbol: "NASDAQ:MSFT", label: "Microsoft Corp. (NASDAQ)" } as const;

describe("backend rules on a compared symbol", () => {
  it("a compared symbol's price against a value or two values is the backend's", () => {
    expect(evaluatedByBackend(rule({ left: msft }))).toBe(true);
    expect(evaluatedByBackend(rule({ left: msft, op: "entering", right: { kind: "value", value: 2 }, right2: { kind: "value", value: 1 } }))).toBe(true);
    expect(evaluatedByBackend(rule({ left: msft, op: "moving_up_pct" }))).toBe(false);
    expect(evaluatedByBackend(rule({ left: msft, right: { kind: "drawing", drawingId: "d" } }))).toBe(false);
    expect(evaluatedByBackend(rule({ left: msft, right: { kind: "indicator", indicatorId: "i" } }))).toBe(false);
  });

  it("is compiled on the compared symbol's quotes and sessions", () => {
    mocks.sessions.set("NASDAQ:MSFT", new SymbolSessions(usStock));
    mocks.rules = [rule({ left: msft })];
    const now = Date.UTC(2026, 9, 15, 15) / 1000;
    const { rules, grids } = compileBackendRules(now, 1);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ id: "r1", symbol: "NASDAQ:MSFT", grid: "NASDAQ:MSFT|1D|RTH", values: [500], shape: "level" });
    expect(grids.map((g) => g.key)).toEqual(["NASDAQ:MSFT|1D|RTH"]);
    // Without the compared symbol's sessions: not handed over yet.
    mocks.sessions.clear();
    expect(compileBackendRules(now, 2).rules).toHaveLength(0);
  });
});
