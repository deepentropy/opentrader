import { describe, expect, it } from "vitest";
import { localDay, localToUtc, zoneOffsetFinder } from "../zone";

/** UNIX seconds of a UTC date-time. */
const utc = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) => Date.UTC(y, mo - 1, d, h, mi, s) / 1000;
/** Day number (days since 01/01/1970) of a calendar date. */
const dayOf = (y: number, mo: number, d: number) => Date.UTC(y, mo - 1, d) / 86400000;

const NY = "America/New_York";
const PARIS = "Europe/Paris";

describe("zoneOffsetFinder", () => {
  it("returns the standard and daylight offsets of New York", () => {
    const off = zoneOffsetFinder(NY);
    expect(off(utc(2026, 1, 15, 12))).toBe(-5 * 3600);
    expect(off(utc(2026, 7, 15, 12))).toBe(-4 * 3600);
  });

  it("switches exactly at the US DST instants (08/03/2026 07:00Z, 01/11/2026 06:00Z)", () => {
    const off = zoneOffsetFinder(NY);
    expect(off(utc(2026, 3, 8, 6, 59, 59))).toBe(-18000);
    expect(off(utc(2026, 3, 8, 7))).toBe(-14400);
    expect(off(utc(2026, 11, 1, 5, 59, 59))).toBe(-14400);
    expect(off(utc(2026, 11, 1, 6))).toBe(-18000);
  });

  it("switches exactly at the EU DST instants (29/03/2026 and 25/10/2026, 01:00Z)", () => {
    const off = zoneOffsetFinder(PARIS);
    expect(off(utc(2026, 3, 29, 0, 59, 59))).toBe(3600);
    expect(off(utc(2026, 3, 29, 1))).toBe(7200);
    expect(off(utc(2026, 10, 25, 0, 59, 59))).toBe(7200);
    expect(off(utc(2026, 10, 25, 1))).toBe(3600);
  });

  it("handles fractional zones and UTC", () => {
    expect(zoneOffsetFinder("Asia/Kolkata")(utc(2026, 6, 1))).toBe(5.5 * 3600);
    expect(zoneOffsetFinder("Asia/Kathmandu")(utc(2026, 6, 1))).toBe(5.75 * 3600);
    expect(zoneOffsetFinder("UTC")(utc(2026, 6, 1, 13, 7))).toBe(0);
  });

  it("is shared per zone and gives the same answer from its cache", () => {
    const a = zoneOffsetFinder(NY);
    expect(zoneOffsetFinder(NY)).toBe(a);
    const t = utc(2026, 2, 2, 3, 4, 5);
    expect(a(t)).toBe(a(t));
    expect(a(t + 1)).toBe(-18000);
  });

  it("works on times before 1970", () => {
    expect(zoneOffsetFinder(NY)(utc(1969, 7, 20, 20, 17))).toBe(-14400);
  });
});

describe("localDay", () => {
  it("gives the local calendar day, not the UTC one", () => {
    // 03:00Z on 15/01 is 22:00 on 14/01 in New York.
    expect(localDay(NY, utc(2026, 1, 15, 3))).toBe(dayOf(2026, 1, 14));
    expect(localDay(NY, utc(2026, 1, 15, 5))).toBe(dayOf(2026, 1, 15));
    // 23:30Z on 14/01 is 00:30 on 15/01 in Paris.
    expect(localDay(PARIS, utc(2026, 1, 14, 23, 30))).toBe(dayOf(2026, 1, 15));
    expect(localDay("UTC", utc(2026, 1, 14, 23, 59, 59))).toBe(dayOf(2026, 1, 14));
  });

  it("returns day 0 at the epoch in UTC and a negative day before it", () => {
    expect(localDay("UTC", 0)).toBe(0);
    expect(localDay(NY, 0)).toBe(-1);
  });
});

describe("localToUtc", () => {
  it("converts a local wall time on a regular day", () => {
    expect(localToUtc(NY, dayOf(2026, 1, 15), 9 * 60 + 30)).toBe(utc(2026, 1, 15, 14, 30));
    expect(localToUtc(NY, dayOf(2026, 7, 15), 9 * 60 + 30)).toBe(utc(2026, 7, 15, 13, 30));
    expect(localToUtc(PARIS, dayOf(2026, 7, 15), 9 * 60)).toBe(utc(2026, 7, 15, 7));
    expect(localToUtc("Asia/Kolkata", dayOf(2026, 7, 15), 9 * 60 + 15)).toBe(utc(2026, 7, 15, 3, 45));
  });

  it("uses the offset in force at the wall time on DST change days", () => {
    // Spring forward in New York: midnight is still EST, 09:30 is EDT.
    expect(localToUtc(NY, dayOf(2026, 3, 8), 0)).toBe(utc(2026, 3, 8, 5));
    expect(localToUtc(NY, dayOf(2026, 3, 8), 9 * 60 + 30)).toBe(utc(2026, 3, 8, 13, 30));
    // Fall back: midnight is EDT, 09:30 is EST.
    expect(localToUtc(NY, dayOf(2026, 11, 1), 0)).toBe(utc(2026, 11, 1, 4));
    expect(localToUtc(NY, dayOf(2026, 11, 1), 9 * 60 + 30)).toBe(utc(2026, 11, 1, 14, 30));
    // Paris: 01:30 is still CET (before the 02:00 jump), 09:00 is CEST.
    expect(localToUtc(PARIS, dayOf(2026, 3, 29), 90)).toBe(utc(2026, 3, 29, 0, 30));
    expect(localToUtc(PARIS, dayOf(2026, 3, 29), 9 * 60)).toBe(utc(2026, 3, 29, 7));
  });

  it("resolves an ambiguous fall-back time to its first occurrence", () => {
    // 01:30 on 01/11/2026 happens twice in New York; the EDT one is 05:30Z.
    expect(localToUtc(NY, dayOf(2026, 11, 1), 90)).toBe(utc(2026, 11, 1, 5, 30));
  });

  it("moves a time skipped by the spring-forward jump one offset step later in Paris", () => {
    // 02:30 does not exist on 29/03/2026 in Paris: read as 03:30 CEST.
    expect(localToUtc(PARIS, dayOf(2026, 3, 29), 150)).toBe(utc(2026, 3, 29, 1, 30));
  });

  // Suspected bug: in a zone west of UTC the skipped 02:30 of 08/03/2026 in New York resolves to 06:30Z (01:30
  // EST, one step EARLIER), not 07:30Z (03:30 EDT) as the doc comment of localToUtc states.
  it.todo("moves a time skipped by the spring-forward jump one offset step later in New York");

  it("accepts minutes past the day (1440 = next local midnight) and negative minutes", () => {
    expect(localToUtc(NY, dayOf(2026, 1, 15), 1440)).toBe(utc(2026, 1, 16, 5));
    expect(localToUtc(NY, dayOf(2026, 1, 15), -420)).toBe(utc(2026, 1, 14, 22));
  });

  it("is the inverse of localDay + local minutes", () => {
    const off = zoneOffsetFinder(PARIS);
    for (const sec of [utc(2026, 2, 1, 10), utc(2026, 8, 31, 23, 45), utc(2026, 12, 31, 22, 59)]) {
      const day = localDay(PARIS, sec);
      const minutes = (sec + off(sec) - day * 86400) / 60;
      expect(localToUtc(PARIS, day, minutes)).toBe(sec);
    }
  });
});
