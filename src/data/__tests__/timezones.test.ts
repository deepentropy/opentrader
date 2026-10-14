import { describe, expect, it } from "vitest";
import { DEFAULT_TIMEZONE_LABEL, TIMEZONES, findTimezone } from "../timezones";
import { zoneOffsetFinder } from "../session/zone";

/** "(UTC+5:30) Kolkata" → 19800 seconds; "(UTC) Azores" → 0. */
function labelOffset(label: string): number | null {
  const m = /^\(UTC(?:([+-])(\d+)(?::(\d+))?)?\)/.exec(label);
  if (!m) return null;
  if (!m[1]) return 0;
  const sec = Number(m[2]) * 3600 + Number(m[3] ?? 0) * 60;
  return m[1] === "-" ? -sec : sec;
}

describe("TIMEZONES", () => {
  it("starts with UTC and Exchange, labels are unique", () => {
    expect(TIMEZONES[0]).toEqual({ label: "UTC", iana: "UTC" });
    expect(TIMEZONES[1].label).toBe("Exchange");
    expect(new Set(TIMEZONES.map((t) => t.label)).size).toBe(TIMEZONES.length);
  });

  it("every IANA name is known to Intl", () => {
    for (const t of TIMEZONES) expect(() => new Intl.DateTimeFormat("en-US", { timeZone: t.iana }), t.iana).not.toThrow();
  });

  it("each row's UTC offset is the zone's winter or summer offset", () => {
    const jan = Date.UTC(2026, 0, 15) / 1000;
    const jul = Date.UTC(2026, 6, 15) / 1000;
    for (const t of TIMEZONES.slice(2)) {
      const want = labelOffset(t.label);
      expect(want, t.label).not.toBeNull();
      const off = zoneOffsetFinder(t.iana);
      expect([off(jan), off(jul)], t.label).toContain(want);
    }
  });

  it("is ordered by offset (west to east) after the two special rows", () => {
    const offs = TIMEZONES.slice(2).map((t) => labelOffset(t.label)!);
    expect([...offs].sort((a, b) => a - b)).toEqual(offs);
  });
});

describe("findTimezone", () => {
  it("finds a row by its label", () => {
    expect(findTimezone(DEFAULT_TIMEZONE_LABEL)).toEqual({ label: "(UTC-4) New York", iana: "America/New_York" });
    expect(findTimezone("(UTC+5:45) Kathmandu")?.iana).toBe("Asia/Kathmandu");
    expect(findTimezone("New York")).toBeUndefined();
    expect(findTimezone("")).toBeUndefined();
  });
});
