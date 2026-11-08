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
  renameLocalSeries,
} from "../local-series";

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

    expect(await localSession("LOCAL:MIN1")).toMatchObject({ timezone: "Etc/UTC", session: "24x7", pricescale: 10 });
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
