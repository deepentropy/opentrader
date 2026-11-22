import { describe, expect, it, vi } from "vitest";
import type { SymbolEvent, SymbolSession } from "../../bindings";

// A data plugin's symbol events (#382): the chart's markers come from its plugin, not the app's own data.
const mocks = vi.hoisted(() => ({
  getSymbolSession: vi.fn(),
  pluginEvents: vi.fn(),
  getDividends: vi.fn(async () => ({ status: "ok", data: [] })),
  getSplits: vi.fn(async () => ({ status: "ok", data: [] })),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn() }));
vi.mock("../../bindings", () => ({ commands: mocks }));
vi.mock("../kv", () => ({
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
  onExternalChange: () => () => undefined,
}));

import { getEvents } from "../datafeed";

const session = (intervals: string[]): SymbolSession => ({
  barOrigin: null,
  timezone: "Asia/Kolkata",
  session: "0915-1530",
  subsessions: [{ id: "regular", description: "Regular Trading Hours", session: "0915-1530", corrections: "" }],
  holidays: "",
  corrections: "",
  pricescale: 100,
  minmov: 5,
  variableTickSize: "",
  intervals,
});
mocks.getSymbolSession.mockImplementation(async (symbol: string) => ({ status: "ok", data: session(symbol.startsWith("NSE:") ? ["1", "1D"] : []) }));

const event = (e: Partial<SymbolEvent> & Pick<SymbolEvent, "kind" | "date">): SymbolEvent => ({
  amount: null, payDate: null, from: null, to: null, fiscalPeriod: null, fiscalYear: null, periodEnd: null,
  session: null, eps: null, revenue: null, currency: null, ...e,
});
const DAY = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 1000;
// Midnight in Kolkata (UTC+05:30): the daily bar's stamp.
const KOLKATA = (iso: string) => DAY(iso) - 5.5 * 3600;

describe("a data plugin's symbol events", () => {
  it("places its plugin's dividends, splits and earnings on their daily bars", async () => {
    mocks.pluginEvents.mockResolvedValueOnce({
      status: "ok",
      data: [
        event({ kind: "dividend", date: DAY("2024-08-19"), amount: 10, payDate: DAY("2024-09-06") }),
        event({ kind: "split", date: DAY("2024-10-28"), from: 1, to: 2 }),
        event({ kind: "earnings", date: DAY("2025-01-16"), fiscalPeriod: "Q3", fiscalYear: 2025, periodEnd: DAY("2024-12-31"), session: "amc", eps: 13.7 }),
      ],
    });
    const list = await getEvents("NSE:RELIANCE");
    expect(mocks.getDividends).not.toHaveBeenCalled();
    expect(list.map((e) => [e.kind, e.time, e.label])).toEqual([
      ["dividend", KOLKATA("2024-08-19"), "10.00"],
      ["split", KOLKATA("2024-10-28"), "2:1"],
      ["earnings", KOLKATA("2025-01-16"), "Q3 '25"],
    ]);
    expect(list[0].payDate).toBe(KOLKATA("2024-09-06"));
    expect(list[2]).toMatchObject({ periodEnd: DAY("2024-12-31"), session: "amc", eps: 13.7, revenue: null });
  });

  it("has none when its plugin can't give them", async () => {
    mocks.pluginEvents.mockResolvedValueOnce({ status: "error", error: "plugin failed" });
    expect(await getEvents("NSE:TCS")).toEqual([]);
  });

  it("leaves the app's own symbols to the app's data", async () => {
    mocks.pluginEvents.mockClear();
    await getEvents("XNSE:OWN").catch(() => undefined);
    expect(mocks.pluginEvents).not.toHaveBeenCalled();
    expect(mocks.getDividends).toHaveBeenCalledWith("XNSE:OWN");
  });
});
