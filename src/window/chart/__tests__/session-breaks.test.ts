import { describe, expect, it, vi } from "vitest";

vi.mock("../../../bindings", () => ({ commands: {} }));

import { SessionSpec } from "../../../data/session/spec";
import { localToUtc } from "../../../data/session/zone";
import { computeSessionBoundaries } from "../session-breaks";

const NY = "America/New_York";
const dayNo = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d) / 86400000;
/** UNIX seconds of New York wall time. */
const ny = (y: number, m: number, d: number, h: number, mi = 0) => localToUtc(NY, dayNo(y, m, d), h * 60 + mi);
const bars = (...times: number[]) => times.map((time) => ({ time }));

const rth = new SessionSpec(NY, "0930-1600");
const eth = new SessionSpec(NY, "0400-2000");

describe("computeSessionBoundaries", () => {
  it("marks the first bar of every new trading day", () => {
    const b = bars(ny(2026, 1, 6, 15, 50), ny(2026, 1, 6, 15, 55), ny(2026, 1, 7, 9, 30), ny(2026, 1, 7, 9, 35), ny(2026, 1, 8, 9, 30));
    expect(computeSessionBoundaries(b, true, rth)).toEqual([ny(2026, 1, 7, 9, 30), ny(2026, 1, 8, 9, 30)]);
  });

  it("nothing on daily+ frames or with fewer than 2 bars", () => {
    const b = bars(ny(2026, 1, 6, 0), ny(2026, 1, 7, 0));
    expect(computeSessionBoundaries(b, false, rth)).toEqual([]);
    expect(computeSessionBoundaries(bars(ny(2026, 1, 6, 10)), true, rth)).toEqual([]);
    expect(computeSessionBoundaries([], true, rth)).toEqual([]);
  });

  it("extended session: the break is at 04:00, not at 09:30", () => {
    const b = bars(ny(2026, 1, 6, 19, 55), ny(2026, 1, 7, 4, 0), ny(2026, 1, 7, 9, 30), ny(2026, 1, 7, 16, 0));
    expect(computeSessionBoundaries(b, true, eth)).toEqual([ny(2026, 1, 7, 4, 0)]);
  });

  it("a weekend gap gives one break on Monday", () => {
    const b = bars(ny(2026, 1, 9, 15, 55), ny(2026, 1, 12, 9, 30), ny(2026, 1, 12, 9, 35));
    expect(computeSessionBoundaries(b, true, rth)).toEqual([ny(2026, 1, 12, 9, 30)]);
  });

  it("overnight session: the break is at the evening open, which starts the next trading day", () => {
    const globex = new SessionSpec(NY, "1800-1700");
    const b = bars(ny(2026, 1, 6, 16, 55), ny(2026, 1, 6, 18, 0), ny(2026, 1, 6, 23, 0), ny(2026, 1, 7, 9, 30));
    expect(computeSessionBoundaries(b, true, globex)).toEqual([ny(2026, 1, 6, 18, 0)]);
  });

  it("a lunch break inside one trading day is not a break", () => {
    const lunch = new SessionSpec("Asia/Tokyo", "0900-1130,1230-1530");
    const tk = (h: number, mi = 0) => localToUtc("Asia/Tokyo", dayNo(2026, 1, 6), h * 60 + mi);
    expect(computeSessionBoundaries(bars(tk(11, 25), tk(12, 30), tk(15, 25)), true, lunch)).toEqual([]);
  });

  it("a bar outside the session belongs to the next trading day", () => {
    // 17:00 is after the regular close: it opens the next trading day.
    const b = bars(ny(2026, 1, 6, 15, 55), ny(2026, 1, 6, 17, 0), ny(2026, 1, 7, 9, 30));
    expect(computeSessionBoundaries(b, true, rth)).toEqual([ny(2026, 1, 6, 17, 0)]);
  });
});
