import { describe, expect, it, vi } from "vitest";
import type { SymbolSession } from "../../../bindings";

vi.mock("../../../bindings", () => ({ commands: { getSymbolSession: vi.fn() } }));
vi.mock("../../../data/providers", () => ({ defaultExchange: () => "NASDAQ" }));

import { SymbolSessions } from "../../../data/session/symbol-sessions";
import { toProfile } from "../custom-series";
import { pocOf, valueArea } from "../profiles/vbp-engine";
import type { OHLC } from "../chart-types";
import type { UTCTimestamp } from "lightweight-charts";

const session: SymbolSession = {
  timezone: "America/New_York",
  session: "0930-1600",
  subsessions: [],
  holidays: "",
  corrections: "",
  pricescale: 100,
  minmov: 1,
  variableTickSize: "",
};

const t0 = Date.UTC(2026, 10, 2, 15, 0) / 1000;
const bar = (i: number, low: number, high: number): OHLC => ({
  time: (t0 + i * 60) as UTCTimestamp,
  open: low,
  high,
  low,
  close: high,
});

describe("chart-type profile POC and value area", () => {
  it("follow the profile studies' rules (equal rows: POC closest to the middle)", () => {
    // One bar across the whole range: the 24 TPO rows all hold one print.
    const [first] = toProfile([bar(0, 100, 124)], "tpo", undefined, new SymbolSessions(session));
    const p = first.profile!;
    expect(p.poc).toBe(12);
    expect(p.poc).toBe(pocOf(p.up));
    expect([p.vaLo, p.vaHi]).toEqual(valueArea(p.up, p.poc, 70));
  });

  it("match pocOf / valueArea on an uneven profile", () => {
    const bars = [bar(0, 100, 124), bar(1, 104, 110), bar(2, 106, 112), bar(3, 101, 103), bar(4, 115, 120)];
    const [first] = toProfile(bars, "tpo", undefined, new SymbolSessions(session));
    const p = first.profile!;
    const poc = pocOf(p.up);
    expect(p.poc).toBe(poc);
    expect([p.vaLo, p.vaHi]).toEqual(valueArea(p.up, poc, 70));
  });
});
