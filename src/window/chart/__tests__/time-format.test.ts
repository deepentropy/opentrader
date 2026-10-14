import { describe, expect, it } from "vitest";
import { dateFormatKey, formatChartTime, formatTickMark } from "../time-format";

const NY = "America/New_York";
const utc = (y: number, m: number, d: number, h = 0, mi = 0, s = 0) => Date.UTC(y, m - 1, d, h, mi, s) / 1000;
// Wed 23 Sep 2026 14:05:09 New York (EDT, UTC-4).
const T = utc(2026, 9, 23, 18, 5, 9);

describe("dateFormatKey", () => {
  it("defaults to dd MMM 'yy", () => {
    expect(dateFormatKey()).toBe("dd MMM 'yy");
    expect(dateFormatKey("")).toBe("dd MMM 'yy");
  });

  it("maps preset samples to format keys and drops the weekday", () => {
    expect(dateFormatKey("Mon 29 Sep '97")).toBe("dd MMM 'yy");
    expect(dateFormatKey("29 Sep '97")).toBe("dd MMM 'yy");
    expect(dateFormatKey("1997-09-29")).toBe("yyyy-MM-dd");
    expect(dateFormatKey("09/29/97")).toBe("MM/dd/yy");
    expect(dateFormatKey("29/09/97")).toBe("dd/MM/yy");
    expect(dateFormatKey("Sep 29, 1997")).toBe("MMM dd, yyyy");
    expect(dateFormatKey("Q3 '97")).toBe("qq 'yy");
  });
});

describe("formatChartTime", () => {
  it("daily: weekday + date in the default format", () => {
    expect(formatChartTime(T, NY, false, false)).toBe("Wed 23 Sep '26");
  });

  it("daily without weekday", () => {
    expect(formatChartTime(T, NY, false, false, { dayOfWeek: false })).toBe("23 Sep '26");
  });

  it("intraday: date, three spaces, 24h time in the zone", () => {
    expect(formatChartTime(T, NY, true, false)).toBe("Wed 23 Sep '26   14:05");
    expect(formatChartTime(T, NY, true, true)).toBe("Wed 23 Sep '26   14:05:09");
    expect(formatChartTime(T, "UTC", true, false)).toBe("Wed 23 Sep '26   18:05");
  });

  it("applies the Date format preset", () => {
    expect(formatChartTime(T, NY, false, false, { dateFormat: "1997-09-29", dayOfWeek: false })).toBe("2026-09-23");
    expect(formatChartTime(T, NY, false, false, { dateFormat: "09/29/97", dayOfWeek: false })).toBe("09/23/26");
    expect(formatChartTime(T, NY, false, false, { dateFormat: "Q3 '97", dayOfWeek: false })).toBe("Q3 '26");
  });

  it("quarters: January is Q1, December Q4", () => {
    expect(formatChartTime(utc(2026, 1, 10, 12), "UTC", false, false, { dateFormat: "Q3 '97", dayOfWeek: false })).toBe("Q1 '26");
    expect(formatChartTime(utc(2026, 12, 10, 12), "UTC", false, false, { dateFormat: "Q3 '97", dayOfWeek: false })).toBe("Q4 '26");
  });

  it("12-hour time format", () => {
    const text = formatChartTime(T, NY, true, false, { timeFormat: "12-hours", dayOfWeek: false });
    expect(text.startsWith("23 Sep '26   02:05")).toBe(true);
    expect(text.toLowerCase()).toContain("pm");
  });

  it("the weekday follows the zone date, not the UTC date", () => {
    // Thu 24 Sep 02:00 UTC = Wed 23 Sep 22:00 New York.
    expect(formatChartTime(utc(2026, 9, 24, 2), NY, false, false)).toBe("Wed 23 Sep '26");
  });
});

describe("formatTickMark", () => {
  it("year / month / day / time ticks", () => {
    expect(formatTickMark(T, "Year", NY)).toBe("2026");
    expect(formatTickMark(T, "Month", NY)).toBe("Sep");
    expect(formatTickMark(T, "DayOfMonth", NY)).toBe("23");
    expect(formatTickMark(T, "Time", NY)).toBe("14:05");
    expect(formatTickMark(T, "TimeWithSeconds", NY)).toBe("14:05:09");
  });

  it("day of month has no leading zero; midnight is 00:00", () => {
    const t = utc(2026, 3, 5, 0, 0);
    expect(formatTickMark(t, "DayOfMonth", "UTC")).toBe("5");
    expect(formatTickMark(t, "Time", "UTC")).toBe("00:00");
  });

  it("12-hour ticks", () => {
    expect(formatTickMark(T, "Time", NY, "12-hours").toLowerCase()).toMatch(/^02:05\s*pm$/);
  });
});
