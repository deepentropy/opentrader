import { describe, expect, it } from "vitest";
import type { Snapshot } from "../../../data/datafeed";
import type { LiveQuote } from "../../../data/quotes";
import type { YearRange } from "../ticker-stats";
import { detailQuote, widenYearRange } from "../detail-quote";

const T0 = Date.UTC(2026, 10, 13, 15, 30, 20); // the snapshot's stamp, 20 s into its minute

const snap: Snapshot = {
  ticker: "EURUSD",
  last: 1.10301,
  change: 0.002,
  changePercent: 0.18,
  dayHigh: 1.1035,
  dayLow: 1.0998,
  dayVolume: 1000,
  extChangePercent: null,
  source: "live",
  updatedMs: T0,
};

function live(over: Partial<LiveQuote>): LiveQuote {
  return {
    last: 1.10293,
    change: 0.00192,
    changePercent: 0.17,
    extChangePercent: null,
    volume: 1200,
    dayHigh: 1.1035,
    dayLow: 1.0998,
    time: T0 - 20_000 + 60_000,
    source: "live",
    ...over,
  };
}

const year = (low: number, high: number): YearRange => ({
  low,
  high,
  avgVolume30d: 10,
  performance: { "1W": 1, "1M": null, "3M": null, "6M": null, YTD: null, "1Y": null },
});

describe("detailQuote", () => {
  it("is the snapshot until a live quote arrives", () => {
    expect(detailQuote(snap, undefined)).toEqual({
      last: 1.10301, change: 0.002, changePercent: 0.18, extChangePercent: null,
      dayHigh: 1.1035, dayLow: 1.0998, dayVolume: 1000, updatedMs: T0, source: "live",
    });
    expect(detailQuote(null, undefined)).toBeNull();
  });

  it("follows the live quote: price, change, range, volume and the update time", () => {
    const q = detailQuote(snap, live({ dayHigh: 1.104, dayLow: 1.099 }));
    expect(q).toEqual({
      last: 1.10293, change: 0.00192, changePercent: 0.17, extChangePercent: null,
      dayHigh: 1.104, dayLow: 1.099, dayVolume: 1200, updatedMs: T0 - 20_000 + 60_000, source: "live",
    });
  });

  it("keeps the snapshot's values for what a stream trade does not carry, and widens the day's range to its price", () => {
    const trade = live({ last: 1.1041, change: null, changePercent: null, volume: null, dayHigh: null, dayLow: null, source: null });
    const q = detailQuote(snap, trade)!;
    expect(q.last).toBe(1.1041);
    expect([q.change, q.changePercent, q.dayVolume, q.source]).toEqual([0.002, 0.18, 1000, "live"]);
    expect([q.dayLow, q.dayHigh]).toEqual([1.0998, 1.1041]);
    expect(detailQuote(snap, { ...trade, last: 1.0990 })!.dayLow).toBe(1.099);
  });

  it("takes the session's range from the quote once a new session trades after a previous-session snapshot", () => {
    const q = detailQuote({ ...snap, source: "prev" }, live({ dayHigh: 1.1031, dayLow: 1.1027, source: "live" }))!;
    expect([q.dayLow, q.dayHigh, q.source]).toEqual([1.1027, 1.1031, "live"]);
  });

  it("ignores a quote older than the snapshot's minute, not one in the same minute", () => {
    expect(detailQuote(snap, live({ time: T0 - 20_000 - 60_000 }))!.last).toBe(1.10301);
    expect(detailQuote(snap, live({ time: T0 - 20_000 }))!.last).toBe(1.10293);
    // Same minute: the update time stays the snapshot's finer stamp.
    expect(detailQuote(snap, live({ time: T0 - 20_000 }))!.updatedMs).toBe(T0);
  });

  it("keeps the update time of the last trade when a quote has no minute", () => {
    expect(detailQuote(snap, live({ time: null }))!.updatedMs).toBe(T0);
  });

  it("shows a live quote without a snapshot, with no day's range", () => {
    expect(detailQuote(null, live({ dayHigh: null, dayLow: null }))).toEqual({
      last: 1.10293, change: 0.00192, changePercent: 0.17, extChangePercent: null,
      dayHigh: null, dayLow: null, dayVolume: 1200, updatedMs: T0 - 20_000 + 60_000, source: "live",
    });
  });
});

describe("widenYearRange", () => {
  it("keeps the daily bars' range while the day stays inside it", () => {
    const y = year(1.05, 1.12);
    expect(widenYearRange(y, detailQuote(snap, live({})))).toEqual(y);
  });

  it("widens to the day's range and the live price past it", () => {
    const up = widenYearRange(year(1.05, 1.1), detailQuote(snap, live({ last: 1.106, dayHigh: 1.1055 })))!;
    expect([up.low, up.high]).toEqual([1.05, 1.106]);
    const down = widenYearRange(year(1.1, 1.12), detailQuote(snap, undefined))!;
    expect([down.low, down.high]).toEqual([1.0998, 1.12]);
    expect(down.performance).toEqual(year(0, 0).performance);
  });

  it("leaves a missing range or quote as it is", () => {
    const none: YearRange = { ...year(0, 0), low: null, high: null };
    expect(widenYearRange(none, detailQuote(snap, undefined))).toBe(none);
    expect(widenYearRange(null, detailQuote(snap, undefined))).toBeNull();
    const y = year(1, 2);
    expect(widenYearRange(y, null)).toBe(y);
  });
});
