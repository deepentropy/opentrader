import { describe, expect, it, vi } from "vitest";
import type { SymbolSession } from "../../../bindings";

vi.mock("../../../bindings", () => ({ commands: { getSymbolSession: vi.fn() } }));
vi.mock("../../../data/providers", () => ({ defaultExchange: () => "NASDAQ" }));

import { SymbolSessions } from "../../../data/session";
import { countdownText, durationText, marketStatusAt, sessionTimeline, utcOffsetText } from "../legend-status";

const utc = (y: number, mo: number, d: number, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi) / 1000;

/** A US stock: regular 09:30-16:00, pre 04:00-09:30, post 16:00-20:00, one holiday (26/11/2026). */
const stock = new SymbolSessions({
  timezone: "America/New_York",
  session: "0930-1600",
  subsessions: [
    { id: "regular", description: "Regular Trading Hours", session: "0930-1600", corrections: "" },
    { id: "extended", description: "Extended Trading Hours", session: "0400-2000", corrections: "" },
    { id: "premarket", description: "Premarket", session: "0400-0930", corrections: "" },
    { id: "postmarket", description: "Postmarket", session: "1600-2000", corrections: "" },
  ],
  holidays: "20261126",
  corrections: "",
  pricescale: 100,
  minmov: 1,
  variableTickSize: "",
} as SymbolSession);

describe("legend status texts", () => {
  it("words the remaining time as the reference app", () => {
    expect(durationText(2 * 3600 + 28 * 60 + 30)).toBe("2 hours and 28 minutes");
    expect(durationText(3600 + 60)).toBe("1 hour and 1 minute");
    expect(durationText(26 * 3600)).toBe("1 day and 2 hours");
    expect(durationText(2 * 86400)).toBe("2 days and 0 hours");
    expect(durationText(5 * 60 + 59)).toBe("5 minutes");
    expect(durationText(59)).toBe("less than 1 minute");
  });

  it("counts down to the next change of each status (EDT, Wednesday 21/10/2026)", () => {
    // Pre-market 07:02 → regular open at 09:30 (reference: "It’ll open fully in 2 hours and 28 minutes.").
    expect(countdownText(stock, utc(2026, 10, 21, 11, 2))).toBe("It’ll open fully in 2 hours and 28 minutes.");
    // Regular 15:00 → post-market at 16:00.
    expect(countdownText(stock, utc(2026, 10, 21, 19))).toBe("It'll go to post-market trading in 1 hour and 0 minutes.");
    // Post-market 19:30 → close at 20:00.
    expect(countdownText(stock, utc(2026, 10, 21, 23, 30))).toBe("It'll close in 30 minutes.");
    // Closed 02:00 → pre-market at 04:00.
    expect(countdownText(stock, utc(2026, 10, 21, 6))).toBe("It'll open for pre-market trading in 2 hours and 0 minutes.");
  });

  it("tells a holiday from a plain close", () => {
    expect(marketStatusAt(stock, utc(2026, 11, 26, 16))).toBe("holiday");
    expect(marketStatusAt(stock, utc(2026, 10, 24, 16))).toBe("closed"); // Saturday
    expect(marketStatusAt(stock, utc(2026, 10, 21, 16))).toBe("open");
  });

  it("formats the exchange UTC offset", () => {
    expect(utcOffsetText(-4 * 3600)).toBe("UTC-4");
    expect(utcOffsetText(5.5 * 3600)).toBe("UTC+5:30");
    expect(utcOffsetText(0)).toBe("UTC");
  });
});

describe("session timeline", () => {
  it("lays out the exchange day with the current part's bounds (reference: WED, 04:00 09:30)", () => {
    const t = sessionTimeline(stock, utc(2026, 10, 21, 11, 2));
    expect(t.weekday).toBe("Wed");
    expect(t.segments.map((s) => s.type)).toEqual(["closed", "pre", "open", "post", "closed"]);
    const pre = t.segments[1];
    expect(pre.from).toBeCloseTo(4 / 24, 6);
    expect(pre.to).toBeCloseTo(9.5 / 24, 6);
    expect(pre.start && pre.end).toBe(true);
    expect(pre.tooltip).toBe("Pre-market 04:00 — 09:30");
    expect(t.now).toBeCloseTo((7 + 2 / 60) / 24, 6);
    expect(t.marks).toMatchObject({ titles: ["04:00", "09:30"], alignEnds: true });
    expect(t.marks!.left).toBeCloseTo(4 / 24, 6);
    expect(t.zone).toBe("Exchange timezone: New York (UTC-4)");
  });

  it("marks both ends of a closed part, and no session on a holiday", () => {
    const night = sessionTimeline(stock, utc(2026, 10, 21, 6));
    expect(night.marks?.titles).toEqual(["00:00", "04:00"]);
    const holiday = sessionTimeline(stock, utc(2026, 11, 26, 16));
    expect(holiday.segments.map((s) => s.type)).toEqual(["closed"]);
    expect(holiday.segments[0].start && holiday.segments[0].end).toBe(true);
  });
});
