import { describe, expect, it } from "vitest";
import { shownRangeStart, tradingDaysBetween, wantsPastWindow } from "../past-window";

const DAY = 86400;
// Mon 02/11/2026 00:00 UTC.
const MON = Date.UTC(2026, 10, 2) / 1000;

describe("past window loads (#310)", () => {
  // A 10S pane (two trading days per history page) holding Mon..Fri of a week.
  const tenSec = { firstSec: MON, lastSec: MON + 4 * DAY + 57600, pageDays: 2, maxPages: 2 };

  it("counts trading days with a holiday margin", () => {
    expect(tradingDaysBetween(MON, MON)).toBe(2);
    expect(tradingDaysBetween(MON, MON + 7 * DAY)).toBe(8);
  });

  it("loads the bars in between when the date is at most two pages before the loaded bars", () => {
    const near = MON - DAY;
    expect(wantsPastWindow({ ...tenSec, fromSec: near, toSec: near, olderMissing: true, inWindow: false })).toBe(false);
  });

  it("loads a window when the date is more than two pages before the loaded bars", () => {
    const far = MON - 30 * DAY;
    expect(wantsPastWindow({ ...tenSec, fromSec: far, toSec: far, olderMissing: true, inWindow: false })).toBe(true);
    // History exhausted (or the date already loaded): nothing to load.
    expect(wantsPastWindow({ ...tenSec, fromSec: far, toSec: far, olderMissing: false, inWindow: false })).toBe(false);
  });

  it("after a window of past bars: newer pages close to it, a window far from it", () => {
    const close = tenSec.lastSec + DAY;
    const later = tenSec.lastSec + 30 * DAY;
    expect(wantsPastWindow({ ...tenSec, fromSec: close, toSec: close, olderMissing: false, inWindow: true })).toBe(false);
    expect(wantsPastWindow({ ...tenSec, fromSec: later, toSec: later, olderMissing: false, inWindow: true })).toBe(true);
    // The latest bars (not a window): a later date is loaded already.
    expect(wantsPastWindow({ ...tenSec, fromSec: later, toSec: later, olderMissing: false, inWindow: false })).toBe(false);
  });

  it("a synced range longer than the pane shows is loaded from where the pane shows it", () => {
    // A daily pane showing a year, followed by a 10S pane: 3000 bars fit, 2340 bars a day.
    const to = MON + 4 * DAY;
    const from = to - 365 * DAY;
    const start = shownRangeStart(from, to, 3000, 2340);
    // Two trading days back, in calendar days with the weekend and a day of margin.
    expect(start).toBe(to - 4 * DAY);
    expect(wantsPastWindow({ ...tenSec, fromSec: start, toSec: to, olderMissing: start < tenSec.firstSec, inWindow: false })).toBe(false);
    // A range the pane shows whole starts where it starts.
    expect(shownRangeStart(to - 2 * DAY, to, 3000, 390)).toBe(to - 2 * DAY);
    // No width yet: the end of the range only.
    expect(shownRangeStart(from, to, 0, 2340)).toBe(to - DAY);
  });
});
