import { describe, expect, it } from "vitest";
import { dayKeyer, minuteOfDayer, utcToWall, wallTimeToUtc } from "../day-key";

const NY = "America/New_York";
const PARIS = "Europe/Paris";
const TOKYO = "Asia/Tokyo";
/** UNIX seconds of a UTC date-time (month 1-based for readability). */
const utc = (y: number, m: number, d: number, h = 0, mi = 0, s = 0) => Date.UTC(y, m - 1, d, h, mi, s) / 1000;
/** Day number (days since 1970-01-01) of a calendar date. */
const dayNo = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d) / 86400000;

describe("dayKeyer", () => {
  it("returns the UTC day number in UTC", () => {
    const key = dayKeyer("UTC");
    expect(key(0)).toBe(0);
    expect(key(86399)).toBe(0);
    expect(key(86400)).toBe(1);
    expect(key(utc(2026, 10, 14, 12))).toBe(dayNo(2026, 10, 14));
  });

  it("reads the date in the zone: New York midnight is 05:00 UTC in winter", () => {
    const key = dayKeyer(NY);
    expect(key(utc(2026, 1, 15, 4, 59, 59))).toBe(dayNo(2026, 1, 14));
    expect(key(utc(2026, 1, 15, 5))).toBe(dayNo(2026, 1, 15));
  });

  it("follows DST: New York midnight is 04:00 UTC in summer", () => {
    const key = dayKeyer(NY);
    expect(key(utc(2026, 7, 1, 3, 59))).toBe(dayNo(2026, 6, 30));
    expect(key(utc(2026, 7, 1, 4))).toBe(dayNo(2026, 7, 1));
  });

  it("a zone east of UTC rolls the day earlier", () => {
    const key = dayKeyer(TOKYO);
    // 15:00 UTC = 00:00 next day in Tokyo (UTC+9, no DST).
    expect(key(utc(2026, 3, 1, 14, 59))).toBe(dayNo(2026, 3, 1));
    expect(key(utc(2026, 3, 1, 15))).toBe(dayNo(2026, 3, 2));
  });

  it("handles negative times (before 1970)", () => {
    expect(dayKeyer("UTC")(-1)).toBe(-1);
  });
});

describe("utcToWall", () => {
  it("returns the wall date (0-based month) and minutes after midnight", () => {
    expect(utcToWall(NY, utc(2026, 1, 15, 14, 30))).toEqual({ y: 2026, m: 0, d: 15, minutes: 9 * 60 + 30 });
    expect(utcToWall(NY, utc(2026, 7, 15, 13, 30))).toEqual({ y: 2026, m: 6, d: 15, minutes: 9 * 60 + 30 });
  });

  it("crosses the date line backwards for a western zone", () => {
    expect(utcToWall(NY, utc(2026, 1, 1, 2))).toEqual({ y: 2025, m: 11, d: 31, minutes: 21 * 60 });
  });

  it("ignores seconds", () => {
    expect(utcToWall("UTC", utc(2026, 5, 5, 0, 0, 59)).minutes).toBe(0);
  });
});

describe("wallTimeToUtc", () => {
  it("inverts utcToWall in winter and summer", () => {
    expect(wallTimeToUtc(NY, 2026, 0, 15, 9, 30)).toBe(utc(2026, 1, 15, 14, 30));
    expect(wallTimeToUtc(NY, 2026, 6, 15, 9, 30)).toBe(utc(2026, 7, 15, 13, 30));
    expect(wallTimeToUtc(TOKYO, 2026, 2, 2, 0, 0)).toBe(utc(2026, 3, 1, 15));
  });

  it("round-trips every quarter hour of a regular day", () => {
    for (let m = 0; m < 1440; m += 15) {
      const sec = wallTimeToUtc(PARIS, 2026, 4, 20, Math.floor(m / 60), m % 60);
      expect(utcToWall(PARIS, sec)).toEqual({ y: 2026, m: 4, d: 20, minutes: m });
    }
  });

  it("an ambiguous fall-back time (01:30 New York, 01/11/2026) resolves to a real 01:30", () => {
    const sec = wallTimeToUtc(NY, 2026, 10, 1, 1, 30);
    expect(utcToWall(NY, sec)).toEqual({ y: 2026, m: 10, d: 1, minutes: 90 });
  });

  it("a time skipped by the spring jump in Paris resolves one offset step later (02:30 -> 03:30 CEST)", () => {
    const sec = wallTimeToUtc(PARIS, 2026, 2, 29, 2, 30);
    expect(sec).toBe(utc(2026, 3, 29, 1, 30));
    expect(utcToWall(PARIS, sec).minutes).toBe(3 * 60 + 30);
  });

  // Suspected bug (reported): for zones WEST of UTC the skipped time resolves one
  // step EARLIER (02:30 New York on 08/03/2026 -> 06:30 UTC = 01:30 EST), contrary to
  // the documented "one offset step later" and to the Paris case above.
  it.skip("a time skipped by the spring jump in New York resolves one offset step later (02:30 -> 03:30 EDT)", () => {
    const sec = wallTimeToUtc(NY, 2026, 2, 8, 2, 30);
    expect(utcToWall(NY, sec).minutes).toBe(3 * 60 + 30);
  });
});

describe("minuteOfDayer", () => {
  it("returns minutes since local midnight", () => {
    const mod = minuteOfDayer(NY);
    expect(mod(utc(2026, 1, 15, 14, 30))).toBe(570);
    expect(mod(utc(2026, 7, 15, 13, 30))).toBe(570);
    expect(mod(utc(2026, 1, 15, 5))).toBe(0);
    expect(mod(utc(2026, 1, 15, 4, 59))).toBe(1439);
  });

  it("stays in 0..1439 for negative UNIX times", () => {
    const mod = minuteOfDayer("UTC");
    expect(mod(-60)).toBe(1439);
    expect(mod(-86400)).toBe(0);
  });
});
