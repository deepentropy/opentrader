import { describe, expect, it, vi } from "vitest";
import type { SymbolSession } from "../../../bindings";

vi.mock("../../../bindings", () => ({ commands: { getSymbolSession: vi.fn() } }));
vi.mock("../../../data/providers", () => ({ defaultExchange: () => "NASDAQ" }));

import { SymbolSessions } from "../../../data/session";
import { countdownText, durationText, marketStatusAt, sessionTimeline, utcOffsetText, zoneTitle } from "../legend-status";

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
    // Reference titles (checked 21/10/2026): "Kolkata (UTC+5:30)", "Kathmandu (UTC+5:45)", "UTC".
    expect(zoneTitle("Asia/Kolkata", utc(2026, 10, 21))).toBe("Kolkata (UTC+5:30)");
    expect(zoneTitle("Asia/Kathmandu", utc(2026, 10, 21))).toBe("Kathmandu (UTC+5:45)");
    expect(zoneTitle("Etc/UTC", utc(2026, 10, 21))).toBe("UTC");
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
    expect(pre.tip).toEqual({ title: "Pre-market", time: "04:00 — 09:30" });
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

  it("spans a closed part from the previous session's end to the next one's start", () => {
    // Wednesday: 20:00 — 04:00 across midnight; the day ends at "24:00".
    const wed = sessionTimeline(stock, utc(2026, 10, 22, 1)); // 21:00 New York
    expect(wed.segments[0].tip).toEqual({ title: "Market closed", time: "20:00 — 04:00" });
    expect(wed.segments[4].tip.time).toBe("20:00 — 04:00");
    expect(wed.marks?.titles).toEqual(["20:00", "24:00"]);
    expect(wed.segments[2].tip).toEqual({ title: "Market open", time: "09:30 — 16:00" });
    // Saturday: one closed part, Friday's end to Monday's pre-market.
    const sat = sessionTimeline(stock, utc(2026, 10, 24, 16));
    expect(sat.segments).toHaveLength(1);
    expect(sat.segments[0].tip.time).toBe("Fri 20:00 — Mon 04:00");
    // Friday's last part runs to Monday too; the holiday (Thu 26/11) is skipped.
    expect(sessionTimeline(stock, utc(2026, 10, 23, 16)).segments.slice(-1)[0].tip.time).toBe("Fri 20:00 — Mon 04:00");
    expect(sessionTimeline(stock, utc(2026, 11, 25, 16)).segments.slice(-1)[0].tip.time).toBe("Wed 20:00 — Fri 04:00");
  });

  it("lays out the week for the symbol info dialog's All sessions (reference: SUN … SAT, WED active)", () => {
    const sec = utc(2026, 10, 21, 11, 2);
    const day = sessionTimeline(stock, sec);
    const week = sessionTimeline(stock, sec, true);
    expect(day.days).toEqual([{ weekday: "Wed", active: true, segments: day.segments }]);
    expect(week.days.map((d) => d.weekday)).toEqual(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]);
    expect(week.days.filter((d) => d.active).map((d) => d.weekday)).toEqual(["Wed"]);
    expect(week.days[3].segments).toEqual(day.segments);
    expect(week.marks).toEqual(day.marks);
    expect(week.now).toBe(day.now);
    // Weekend: one closed part over the day, Friday's end to Monday's pre-market.
    for (const d of [week.days[0], week.days[6]]) {
      expect(d.segments).toHaveLength(1);
      expect(d.segments[0]).toMatchObject({ type: "closed", from: 0, to: 1, start: true, end: true, tip: { time: "Fri 20:00 — Mon 04:00" } });
    }
    expect(week.days[5].segments.map((s) => s.type)).toEqual(["closed", "pre", "open", "post", "closed"]);
    expect(week.days[5].segments[4].tip.time).toBe("Fri 20:00 — Mon 04:00");
  });

  it("draws a 24-hour session with both bounds (reference: 00:00 — 24:00, UTC)", () => {
    const crypto = new SymbolSessions({
      timezone: "Etc/UTC",
      session: "24x7",
      subsessions: [{ id: "regular", description: "Regular Trading Hours", session: "24x7", corrections: "" }],
      holidays: "",
      corrections: "",
      pricescale: 100,
      minmov: 1,
      variableTickSize: "",
    } as SymbolSession);
    const t = sessionTimeline(crypto, utc(2026, 10, 21, 12));
    expect(t.segments).toHaveLength(1);
    expect(t.segments[0]).toMatchObject({ type: "open", from: 0, to: 1, start: true, end: true, tip: { time: "00:00 — 24:00" } });
    expect(t.marks?.titles).toEqual(["00:00", "24:00"]);
    expect(t.zone).toBe("Exchange timezone: UTC");
  });

  it("shows a session crossing midnight on both days", () => {
    // Futures-like: 18:00 the day before to 17:00.
    const fut = new SymbolSessions({
      timezone: "America/Chicago",
      session: "1700-1600",
      subsessions: [{ id: "regular", description: "Regular Trading Hours", session: "1700-1600", corrections: "" }],
      holidays: "",
      corrections: "",
      pricescale: 100,
      minmov: 1,
      variableTickSize: "",
    } as SymbolSession);
    const t = sessionTimeline(fut, utc(2026, 10, 21, 20)); // Wed 15:00 Chicago
    expect(t.segments.map((s) => [s.type, s.start, s.end])).toEqual([
      ["open", false, true],
      ["closed", true, true],
      ["open", true, false],
    ]);
    expect(t.segments[0].tip.time).toBe("17:00 — 16:00");
    expect(t.marks?.titles).toEqual(["16:00"]);
  });
});
