import { describe, expect, it } from "vitest";
import { SessionSpec, weekdayOf } from "../spec";

const utc = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) => Date.UTC(y, mo - 1, d, h, mi, s) / 1000;
const dayOf = (y: number, mo: number, d: number) => Date.UTC(y, mo - 1, d) / 86400000;

const NY = "America/New_York";

describe("weekdayOf", () => {
  it("numbers days 1 = Sunday … 7 = Saturday from the Thursday 01/01/1970", () => {
    expect(weekdayOf(0)).toBe(5); // Thursday
    expect(weekdayOf(3)).toBe(1); // Sunday 04/01/1970
    expect(weekdayOf(-1)).toBe(4); // Wednesday 31/12/1969
    expect(weekdayOf(-5)).toBe(7); // Saturday 27/12/1969
    expect(weekdayOf(dayOf(2026, 10, 14))).toBe(4); // Wednesday
    expect(weekdayOf(dayOf(2026, 10, 17))).toBe(7); // Saturday
    expect(weekdayOf(dayOf(2026, 10, 18))).toBe(1); // Sunday
  });
});

describe("SessionSpec: US equities 0930-1600", () => {
  const s = new SessionSpec(NY, "0930-1600");
  const wed = dayOf(2026, 10, 14);

  it("has one interval per weekday, in exchange time (EDT in October)", () => {
    expect(s.dayIntervals(wed)).toEqual([{ day: wed, start: utc(2026, 10, 14, 13, 30), end: utc(2026, 10, 14, 20) }]);
    expect(s.always).toBe(false);
    expect(s.timeZone).toBe(NY);
  });

  it("follows the zone's winter offset", () => {
    const thu = dayOf(2026, 1, 15);
    expect(s.dayBounds(thu)).toEqual({ start: utc(2026, 1, 15, 14, 30), end: utc(2026, 1, 15, 21) });
  });

  it("opens one hour earlier in UTC on the Monday after the DST change", () => {
    expect(s.dayBounds(dayOf(2026, 3, 6))!.start).toBe(utc(2026, 3, 6, 14, 30)); // Friday, EST
    expect(s.dayBounds(dayOf(2026, 3, 9))!.start).toBe(utc(2026, 3, 9, 13, 30)); // Monday, EDT
  });

  it("is closed on weekends (default days are Monday to Friday)", () => {
    expect(s.dayIntervals(dayOf(2026, 10, 17))).toEqual([]);
    expect(s.dayIntervals(dayOf(2026, 10, 18))).toEqual([]);
    expect(s.isTradingDay(dayOf(2026, 10, 17))).toBe(false);
    expect(s.isTradingDay(wed)).toBe(true);
    expect(s.dayBounds(dayOf(2026, 10, 18))).toBeNull();
  });

  it("treats intervals as [start, end)", () => {
    expect(s.contains(utc(2026, 10, 14, 13, 29, 59))).toBe(false);
    expect(s.contains(utc(2026, 10, 14, 13, 30))).toBe(true);
    expect(s.contains(utc(2026, 10, 14, 19, 59, 59))).toBe(true);
    expect(s.contains(utc(2026, 10, 14, 20))).toBe(false);
    expect(s.at(utc(2026, 10, 14, 16))?.day).toBe(wed);
    expect(s.at(utc(2026, 10, 17, 16))).toBeNull();
  });

  it("finds the current or next session", () => {
    // Inside: the session itself.
    expect(s.currentOrNext(utc(2026, 10, 14, 15))?.start).toBe(utc(2026, 10, 14, 13, 30));
    // Before the open: today's session.
    expect(s.currentOrNext(utc(2026, 10, 14, 12))?.day).toBe(wed);
    // At the close: tomorrow's.
    expect(s.currentOrNext(utc(2026, 10, 14, 20))?.day).toBe(dayOf(2026, 10, 15));
    // Friday evening and Saturday: Monday's.
    expect(s.currentOrNext(utc(2026, 10, 16, 21))?.day).toBe(dayOf(2026, 10, 19));
    expect(s.currentOrNext(utc(2026, 10, 17, 12))?.start).toBe(utc(2026, 10, 19, 13, 30));
  });

  it("finds the last closed session", () => {
    // A session that closes exactly at `sec` counts as closed.
    expect(s.previous(utc(2026, 10, 14, 20))?.day).toBe(wed);
    // During a session: the one before.
    expect(s.previous(utc(2026, 10, 14, 15))?.day).toBe(dayOf(2026, 10, 13));
    // On Sunday: Friday's.
    expect(s.previous(utc(2026, 10, 18, 12))?.end).toBe(utc(2026, 10, 16, 20));
    expect(s.currentOrPrevious(utc(2026, 10, 14, 15))?.day).toBe(wed);
    expect(s.currentOrPrevious(utc(2026, 10, 18, 12))?.day).toBe(dayOf(2026, 10, 16));
  });

  it("gives null when nothing is found within maxDays", () => {
    expect(s.currentOrNext(utc(2026, 10, 17, 12), 1)).toBeNull();
    expect(s.previous(utc(2026, 10, 18, 12), 0)).toBeNull();
  });

  it("assigns a time to the trading day of its session, else of the next one", () => {
    expect(s.tradingDay(utc(2026, 10, 14, 15))).toBe(wed);
    expect(s.tradingDay(utc(2026, 10, 14, 23))).toBe(dayOf(2026, 10, 15));
    expect(s.tradingDay(utc(2026, 10, 17, 12))).toBe(dayOf(2026, 10, 19));
  });

  it("caches day intervals (same array returned)", () => {
    expect(s.dayIntervals(wed)).toBe(s.dayIntervals(wed));
  });
});

describe("SessionSpec: holidays and corrections", () => {
  const holidays = "20261126,20261225";
  const corrections = "0930-1300:20261127,20261224;dayoff:20261228";
  const s = new SessionSpec(NY, "0930-1600", holidays, corrections);

  it("closes on holidays", () => {
    expect(s.isTradingDay(dayOf(2026, 11, 26))).toBe(false);
    expect(s.isTradingDay(dayOf(2026, 12, 25))).toBe(false);
    expect(s.contains(utc(2026, 11, 26, 16))).toBe(false);
    expect(s.currentOrNext(utc(2026, 11, 26, 16))?.day).toBe(dayOf(2026, 11, 27));
  });

  it("uses the corrected hours on early-close days (EST after November 1)", () => {
    expect(s.dayBounds(dayOf(2026, 11, 27))).toEqual({ start: utc(2026, 11, 27, 14, 30), end: utc(2026, 11, 27, 18) });
    expect(s.contains(utc(2026, 11, 27, 18, 30))).toBe(false);
    expect(s.dayBounds(dayOf(2026, 12, 24))!.end).toBe(utc(2026, 12, 24, 18));
  });

  it("closes on a dayoff correction", () => {
    expect(s.isTradingDay(dayOf(2026, 12, 28))).toBe(false);
    expect(s.isTradingDay(dayOf(2026, 12, 29))).toBe(true);
  });

  it("lets a correction win over the holiday list", () => {
    const c = new SessionSpec(NY, "0930-1600", "20261127", "0930-1300:20261127");
    expect(c.dayBounds(dayOf(2026, 11, 27))!.end).toBe(utc(2026, 11, 27, 18));
  });

  it("can open a weekend day through a correction", () => {
    const c = new SessionSpec(NY, "0930-1600", "", "1000-1200:20261017");
    expect(c.dayBounds(dayOf(2026, 10, 17))).toEqual({ start: utc(2026, 10, 17, 14), end: utc(2026, 10, 17, 16) });
  });
});

describe("SessionSpec: overnight sessions", () => {
  // CME-style: 17:00 the day before to 16:00, Monday to Friday, Chicago time.
  const s = new SessionSpec("America/Chicago", "1700-1600:23456");
  const mon = dayOf(2026, 10, 19);

  it("opens on the previous calendar day and belongs to the day it ends", () => {
    expect(s.dayBounds(mon)).toEqual({ start: utc(2026, 10, 18, 22), end: utc(2026, 10, 19, 21) });
    expect(s.at(utc(2026, 10, 18, 23))?.day).toBe(mon);
    expect(s.tradingDay(utc(2026, 10, 18, 23))).toBe(mon);
  });

  it("is closed during the daily break and over the weekend", () => {
    expect(s.contains(utc(2026, 10, 14, 21, 30))).toBe(false); // Wed 16:30 CT
    expect(s.at(utc(2026, 10, 14, 22))?.day).toBe(dayOf(2026, 10, 15)); // Wed 17:00 CT = Thursday's session
    expect(s.contains(utc(2026, 10, 16, 22))).toBe(false); // Fri 17:00 CT: no Saturday session
    expect(s.contains(utc(2026, 10, 17, 18))).toBe(false); // Saturday
    expect(s.currentOrNext(utc(2026, 10, 17, 18))?.day).toBe(mon);
  });

  it("reads an explicit F marker like the implied overnight start", () => {
    const f = new SessionSpec("America/Chicago", "1700F-1600:23456");
    expect(f.dayBounds(mon)).toEqual(s.dayBounds(mon));
    const f2 = new SessionSpec("America/Chicago", "1700F2-1600:23456");
    expect(f2.dayBounds(mon)!.start).toBe(utc(2026, 10, 17, 22));
  });

  it("reads 0000 as the end of the day", () => {
    const m = new SessionSpec("UTC", "2000-0000:1234567");
    expect(m.dayBounds(dayOf(2026, 10, 14))).toEqual({ start: utc(2026, 10, 14, 20), end: utc(2026, 10, 15) });
    // 0000-0000 is the whole day.
    const whole = new SessionSpec("UTC", "0000-0000:1234567");
    expect(whole.dayBounds(dayOf(2026, 10, 14))).toEqual({ start: utc(2026, 10, 14), end: utc(2026, 10, 15) });
  });
});

describe("SessionSpec: grammar", () => {
  it("24x7 is always open, one session per calendar day", () => {
    const s = new SessionSpec("UTC", "24x7");
    expect(s.always).toBe(true);
    const sat = dayOf(2026, 10, 17);
    expect(s.dayBounds(sat)).toEqual({ start: utc(2026, 10, 17), end: utc(2026, 10, 18) });
    expect(s.contains(utc(2026, 10, 18, 3))).toBe(true);
    expect(new SessionSpec("UTC", "24X7").always).toBe(true);
  });

  it("24x7 with holidays or corrections is not 'always'", () => {
    const s = new SessionSpec("UTC", "24x7", "20261225");
    expect(s.always).toBe(false);
    expect(s.isTradingDay(dayOf(2026, 12, 25))).toBe(false);
    expect(new SessionSpec("UTC", "24x7", "", "dayoff:20261225").always).toBe(false);
  });

  it("reads several intervals per day (lunch break)", () => {
    const s = new SessionSpec("UTC", "0900-1130,1230-1530");
    const wed = dayOf(2026, 10, 14);
    expect(s.dayIntervals(wed).map((i) => [i.start, i.end])).toEqual([
      [utc(2026, 10, 14, 9), utc(2026, 10, 14, 11, 30)],
      [utc(2026, 10, 14, 12, 30), utc(2026, 10, 14, 15, 30)],
    ]);
    expect(s.contains(utc(2026, 10, 14, 12))).toBe(false);
    expect(s.currentOrNext(utc(2026, 10, 14, 12))?.start).toBe(utc(2026, 10, 14, 12, 30));
    expect(s.previous(utc(2026, 10, 14, 12))?.end).toBe(utc(2026, 10, 14, 11, 30));
    expect(s.dayBounds(wed)).toEqual({ start: utc(2026, 10, 14, 9), end: utc(2026, 10, 14, 15, 30) });
  });

  it("sorts intervals given out of order", () => {
    const s = new SessionSpec("UTC", "1230-1530,0900-1130");
    expect(s.dayIntervals(dayOf(2026, 10, 14))[0].start).toBe(utc(2026, 10, 14, 9));
  });

  it("joins U / S parts as separate intervals", () => {
    const s = new SessionSpec("UTC", "0900-1100U1200-1400");
    expect(s.dayIntervals(dayOf(2026, 10, 14))).toHaveLength(2);
  });

  it("ignores E (extension) and A (offset) markers", () => {
    const s = new SessionSpec("UTC", "0930-1600E0400-2000");
    expect(s.dayBounds(dayOf(2026, 10, 14))).toEqual({ start: utc(2026, 10, 14, 9, 30), end: utc(2026, 10, 14, 16) });
  });

  it("reads explicit day lists, and an explicit day wins over the default section", () => {
    const s = new SessionSpec("UTC", "0930-1600|1000-1400:6");
    expect(s.dayBounds(dayOf(2026, 10, 15))!.start).toBe(utc(2026, 10, 15, 9, 30)); // Thursday: default
    expect(s.dayBounds(dayOf(2026, 10, 16))).toEqual({ start: utc(2026, 10, 16, 10), end: utc(2026, 10, 16, 14) }); // Friday
    const sunToThu = new SessionSpec("UTC", "1000-1400:12345");
    expect(sunToThu.isTradingDay(dayOf(2026, 10, 18))).toBe(true); // Sunday
    expect(sunToThu.isTradingDay(dayOf(2026, 10, 16))).toBe(false); // Friday
  });

  it("skips the first-day-of-week prefix", () => {
    const s = new SessionSpec("UTC", "2;0930-1600");
    expect(s.dayBounds(dayOf(2026, 10, 14))!.start).toBe(utc(2026, 10, 14, 9, 30));
  });

  it("switches schedules at a history date", () => {
    const s = new SessionSpec("UTC", "0930-1600#20261201/1000-1500");
    expect(s.dayBounds(dayOf(2026, 11, 30))!.start).toBe(utc(2026, 11, 30, 9, 30));
    expect(s.dayBounds(dayOf(2026, 12, 1))!.start).toBe(utc(2026, 12, 1, 10));
    expect(s.dayBounds(dayOf(2026, 12, 1))!.end).toBe(utc(2026, 12, 1, 15));
  });

  it("rejects malformed specs", () => {
    expect(() => new SessionSpec("UTC", "bad")).toThrow();
    expect(() => new SessionSpec("UTC", "0930-1600-1700")).toThrow();
    expect(() => new SessionSpec("UTC", "930-1600")).toThrow(/bad session time/);
    expect(() => new SessionSpec("UTC", "0930-1600:8")).toThrow(/bad session days/);
    expect(() => new SessionSpec("UTC", "0930-1600", "2026-11-26")).toThrow(/bad session date/);
    expect(() => new SessionSpec("UTC", "0930-1600", "", "0930-1300")).toThrow(/bad session correction/);
    // Only the last history entry has no date; every earlier one needs one.
    expect(() => new SessionSpec("UTC", "0930-1600/1000-1500")).toThrow(/history/);
    expect(() => new SessionSpec("UTC", "0930-1600#20261201")).toThrow(/history/);
  });
});

describe("SessionSpec: other zones", () => {
  it("NSE 0915-1530 in Asia/Kolkata", () => {
    const s = new SessionSpec("Asia/Kolkata", "0915-1530");
    expect(s.dayBounds(dayOf(2026, 10, 14))).toEqual({ start: utc(2026, 10, 14, 3, 45), end: utc(2026, 10, 14, 10) });
  });

  it("a European session across the October DST change", () => {
    const s = new SessionSpec("Europe/Paris", "0900-1730");
    expect(s.dayBounds(dayOf(2026, 10, 23))!.start).toBe(utc(2026, 10, 23, 7)); // Friday, CEST
    expect(s.dayBounds(dayOf(2026, 10, 26))!.start).toBe(utc(2026, 10, 26, 8)); // Monday, CET
  });
});
