import { describe, expect, it, vi } from "vitest";

// The reload event charts listen to goes to the window.
vi.stubGlobal("window", new EventTarget());

// The commands answered by the web version's in-memory store (the same contract as the desktop's).
vi.mock("../../bindings", async () => {
  const { localSeriesCommands: c } = await import("../../web/local-series");
  const typed = async <T,>(p: Promise<unknown>) => {
    try {
      return { status: "ok" as const, data: (await p) as T };
    } catch (error) {
      return { status: "error" as const, error: String(error) };
    }
  };
  return {
    commands: {
      localSeriesList: () => typed(c.local_series_list({})),
      localSeriesSave: (meta: unknown, rows: unknown) => typed(c.local_series_save({ meta, rows })),
      localSeriesRead: (name: string) => typed(c.local_series_read({ name })),
      localSeriesDelete: (name: string) => typed(c.local_series_delete({ name })),
      localSeriesRename: (from: string, to: string) => typed(c.local_series_rename({ from, to })),
    },
  };
});

import {
  deleteLocalSeries,
  importLocalSeries,
  isLocalSymbol,
  localBarsBefore,
  localDailyBars,
  localIntradayBars,
  localServesResolution,
  localSession,
  localSnapshot,
  localTradingDays,
  renameLocalSeries,
} from "../local-series";
import { barmerge, close, executeScript, request } from "oakscriptjs/script";

/** 1-minute bars over two UTC days, 10:00-10:09 each day. */
function minuteCsv(): string {
  const lines = ["time,open,high,low,close,volume"];
  for (const d of [Date.UTC(2024, 0, 2), Date.UTC(2024, 0, 3)]) {
    for (let i = 0; i < 10; i++) {
      const t = d / 1000 + 10 * 3600 + i * 60;
      lines.push(`${t},${100 + i},${101 + i},${99 + i},${100.5 + i},10`);
    }
  }
  return lines.join("\n");
}

describe("local series", () => {
  it("recognises its symbols", () => {
    expect(isLocalSymbol("LOCAL:ABC")).toBe(true);
    expect(isLocalSymbol("local:abc")).toBe(true);
    expect(isLocalSymbol("NASDAQ:AAPL")).toBe(false);
  });

  it("imports a file and serves its intervals", async () => {
    const { series } = await importLocalSeries({ name: "min1", csv: minuteCsv(), timeZone: "Etc/UTC", description: "Test" });
    expect(series).toMatchObject({ name: "MIN1", base: "1", bars: 20, hasVolume: true, pricescale: 10 });

    expect(localServesResolution("LOCAL:MIN1", "5")).toBe(true);
    expect(localServesResolution("LOCAL:MIN1", "1D")).toBe(true);
    expect(localServesResolution("LOCAL:MIN1", "30S")).toBe(false);

    const five = await localIntradayBars("LOCAL:MIN1", "5");
    expect(five).toHaveLength(4);
    expect(five[0]).toEqual({ time: Date.UTC(2024, 0, 2, 10) / 1000, open: 100, high: 105, low: 99, close: 104.5, volume: 50 });

    const daily = await localDailyBars("LOCAL:MIN1");
    expect(daily.map((b) => b.time)).toEqual([Date.UTC(2024, 0, 2) / 1000, Date.UTC(2024, 0, 3) / 1000]);
    expect(daily[1]).toMatchObject({ open: 100, high: 110, low: 99, close: 109.5, volume: 100 });

    expect(await localIntradayBars("LOCAL:MIN1", "30S")).toEqual([]);
    const before = await localBarsBefore("LOCAL:MIN1", "1", Date.UTC(2024, 0, 3) / 1000, 1);
    expect(before).toHaveLength(10);

    expect(await localSession("LOCAL:MIN1")).toMatchObject({ timezone: "Etc/UTC", session: "0000-0000:34", holidays: "", pricescale: 10 });
    expect(await localSnapshot("LOCAL:MIN1")).toMatchObject({ last: 109.5, change: 0, dayVolume: 100 });
  });

  it("renames and deletes", async () => {
    await importLocalSeries({ name: "OLD", csv: "time,close\n2024-01-01,1\n2024-01-02,2", timeZone: "Etc/UTC" });
    await renameLocalSeries("OLD", "new");
    expect((await localDailyBars("LOCAL:NEW")).length).toBe(2);
    await expect(localDailyBars("LOCAL:OLD")).rejects.toThrow();
    await deleteLocalSeries("NEW");
    await expect(localDailyBars("LOCAL:NEW")).rejects.toThrow();
    await expect(importLocalSeries({ name: "bad name", csv: "time,close\n2024-01-01,1", timeZone: "Etc/UTC" })).rejects.toThrow();
  });
});

describe("localTradingDays (#303)", () => {
  const DAY = 86400;
  /** Weekday daily bars at UTC midnight from 01/10/2026 to 04/12/2026, without `off` ("MM-DD"). */
  const weekdays = (off: string[] = []) => {
    const out: number[] = [];
    for (let t = Date.UTC(2026, 9, 1) / 1000; t <= Date.UTC(2026, 11, 4) / 1000; t += DAY) {
      const d = new Date(t * 1000);
      if (d.getUTCDay() % 6 !== 0 && !off.includes(d.toISOString().slice(5, 10))) out.push(t);
    }
    return out;
  };

  it("trades on the weekdays that have bars; a weekday without a bar is a day off", () => {
    expect(localTradingDays(weekdays(), "Etc/UTC")).toEqual({ session: "0000-0000:23456", holidays: "" });
    expect(localTradingDays(weekdays(["11-26"]), "Etc/UTC")).toEqual({ session: "0000-0000:23456", holidays: "20261126" });
    const all = Array.from({ length: 10 }, (_, i) => Date.UTC(2026, 9, 1) / 1000 + i * DAY);
    expect(localTradingDays(all, "Etc/UTC")).toEqual({ session: "24x7", holidays: "" });
    expect(localTradingDays([], "Etc/UTC")).toEqual({ session: "24x7", holidays: "" });
  });

  it("a month ending on a weekend or a day off completes on its last bar (lookahead off)", () => {
    // 31/10/2026 is a Saturday; 30/11/2026 (a Monday) is left out as a day off.
    const times = weekdays(["11-30"]);
    const bars = times.map((t, i) => ({ time: t, open: i, high: i, low: i, close: i, volume: 1 }));
    const { session, holidays } = localTradingDays(times, "Etc/UTC");
    let out: number[] = [];
    executeScript(() => {
      out = request.security("", "M", () => close, barmerge.gaps_off, barmerge.lookahead_off).toArray();
    }, bars, {}, { tickerid: "LOCAL:TEST", timeframe: "1D", timezone: "Etc/UTC", session: { session, holidays } });
    const at = (md: string) => out[times.findIndex((t) => new Date(t * 1000).toISOString().slice(5, 10) === md)];
    const index = (md: string) => times.findIndex((t) => new Date(t * 1000).toISOString().slice(5, 10) === md);
    expect(at("10-29")).toBeNaN();
    expect(at("10-30")).toBe(index("10-30"));
    expect(at("11-02")).toBe(index("10-30"));
    expect(at("11-26")).toBe(index("10-30"));
    expect(at("11-27")).toBe(index("11-27"));
  });
});
