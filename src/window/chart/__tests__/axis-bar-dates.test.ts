import { describe, expect, it } from "vitest";
import { TickMarkType, type UTCTimestamp } from "lightweight-charts";
import { formatAxisTime, formatTick } from "../view/helpers";

const NY = "America/New_York";
const utc = (y: number, m: number, d: number, h = 0) => (Date.UTC(y, m - 1, d, h) / 1000) as UTCTimestamp;

describe("daily-and-up bar dates on the time axis", () => {
  it("a weekly bar of Mon 1 Jan 2024 (UTC midnight) ticks 2024 in a New York chart", () => {
    const t = utc(2024, 1, 1);
    expect(formatTick(t, TickMarkType.Year, NY, {}, false)).toBe("2024");
    expect(formatAxisTime(t, NY, false, false)).toBe("Mon 01 Jan '24");
  });

  it("a monthly bar keeps its month", () => {
    expect(formatTick(utc(2024, 3, 1), TickMarkType.Month, NY, {}, false)).toBe("Mar");
  });

  it("a daily bar at the exchange's midnight keeps its date", () => {
    // Tue 2 Jan 2024 00:00 New York = 05:00 UTC.
    const t = utc(2024, 1, 2, 5);
    expect(formatTick(t, TickMarkType.DayOfMonth, NY, {}, false)).toBe("2");
    expect(formatAxisTime(t, "America/Los_Angeles", false, false)).toBe("Tue 02 Jan '24");
  });

  it("a daily bar of an exchange east of UTC keeps its date in any chart zone (#268)", () => {
    // Thu 2 Jul 2026 00:00 Kolkata = 1 Jul 18:30 UTC; Tokyo = 1 Jul 15:00 UTC; London (summer) = 1 Jul 23:00 UTC.
    for (const [zone, t] of [
      ["Asia/Kolkata", (utc(2026, 7, 1, 18) + 1800) as UTCTimestamp],
      ["Asia/Tokyo", utc(2026, 7, 1, 15)],
      ["Europe/London", utc(2026, 7, 1, 23)],
    ] as const) {
      expect(formatAxisTime(t, NY, false, false, {}, zone)).toBe("Thu 02 Jul '26");
      expect(formatTick(t, TickMarkType.DayOfMonth, NY, {}, false, zone)).toBe("2");
    }
  });

  it("a New York daily bar keeps its date with the exchange zone given", () => {
    const t = utc(2024, 1, 2, 5);
    expect(formatAxisTime(t, "America/Los_Angeles", false, false, {}, NY)).toBe("Tue 02 Jan '24");
    // A weekly bar at UTC midnight is still read in UTC.
    expect(formatTick(utc(2024, 1, 1), TickMarkType.Year, NY, {}, false, NY)).toBe("2024");
  });

  it("intraday bars stay in the chart's time zone", () => {
    // 1 Jan 2024 03:00 UTC = 31 Dec 2023 22:00 New York.
    const t = utc(2024, 1, 1, 3);
    expect(formatTick(t, TickMarkType.Year, NY)).toBe("2023");
    expect(formatTick(t, TickMarkType.Time, NY, {}, true)).toBe("22:00");
  });
});
