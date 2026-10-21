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

  it("intraday bars stay in the chart's time zone", () => {
    // 1 Jan 2024 03:00 UTC = 31 Dec 2023 22:00 New York.
    const t = utc(2024, 1, 1, 3);
    expect(formatTick(t, TickMarkType.Year, NY)).toBe("2023");
    expect(formatTick(t, TickMarkType.Time, NY, {}, true)).toBe("22:00");
  });
});
