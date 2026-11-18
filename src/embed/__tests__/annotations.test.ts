import { describe, expect, it } from "vitest";
import { MAX_MARKERS, parseEmbedConfig, timeOf } from "../config";
import { frameSpan, highlightBars, markerBar, onChart, type TimeContext } from "../annotations";
import { embedSeedTab } from "../seed";
import { wallTimeToUtc } from "../../window/chart/day-key";

const NY = "America/New_York";
const daily: TimeContext = { dwm: true, zone: NY, barSec: 86400 };
const m5: TimeContext = { dwm: false, zone: NY, barSec: 300 };

/** Daily bars at New York midnight of each weekday from 2026-03-02 (Mon) to 2026-03-13 (Fri). */
const days = [2, 3, 4, 5, 6, 9, 10, 11, 12, 13].map((d) => ({ time: wallTimeToUtc(NY, 2026, 2, d, 0, 0) }));
/** Weekly bars at New York midnight of each Monday. */
const weeks = [2, 9, 16].map((d) => ({ time: wallTimeToUtc(NY, 2026, 2, d, 0, 0) }));
const weekly: TimeContext = { dwm: true, zone: NY, barSec: 7 * 86400 };
/** 5-minute bars of 2026-03-12 and 2026-03-13, 09:30–15:55 New York (UTC-4 after the 08/03 change). */
const bars5 = [12, 13].flatMap((d) =>
  Array.from({ length: 78 }, (_, i) => ({ time: Date.UTC(2026, 2, d, 13, 30) / 1000 + i * 300 })),
);
const at = (d: number, h: number, mi: number) => Date.UTC(2026, 2, d, h, mi) / 1000;

describe("embed times (#366)", () => {
  it("reads dates, exchange times, instants", () => {
    expect(timeOf("2026-03-14")).toEqual({ date: { y: 2026, m: 2, d: 14 } });
    expect(timeOf("2026-03-14 10:30")).toEqual({ wall: { y: 2026, m: 2, d: 14, minutes: 630 } });
    expect(timeOf("2026-03-14T10:30:15")).toEqual({ wall: { y: 2026, m: 2, d: 14, minutes: 630 } });
    expect(timeOf("2026-03-14T10:30:00Z")).toEqual({ sec: at(14, 10, 30) });
    expect(timeOf("2026-03-14T10:30-04:00")).toEqual({ sec: at(14, 14, 30) });
    expect(timeOf(1773484200)).toEqual({ sec: 1773484200 });
    expect(timeOf(1773484200000)).toEqual({ sec: 1773484200 });
    expect(timeOf("1773484200")).toEqual({ sec: 1773484200 });
    for (const bad of ["2026-02-30", "2026-03-14 25:00", "14/03/2026", "", -5, null, {}]) expect(timeOf(bad)).toBeUndefined();
    // Read again (settings changed in place are read over the current ones).
    const t = timeOf("2026-03-14 10:30")!;
    expect(timeOf(t)).toEqual(t);
  });

  it("checks marks and periods", () => {
    const c = parseEmbedConfig({
      markers: [
        { time: "2026-03-05", text: "  Earnings\n call ", color: "#f00", symbol: "nasdaq:aapl" },
        { time: "2026-03-06", position: "below" },
        { time: "2026-03-09", position: "inBar", shape: "square", color: "url(x)" },
        { time: "nope" },
        "x",
      ],
      highlights: [{ from: "2026-03-04", to: "2026-03-10", label: "Rally" }, { from: "2026-03-11" }, { to: "2026-03-11" }],
      from: "2026-03-02",
      layout: "2h",
    });
    expect(c.markers).toEqual([
      { time: { date: { y: 2026, m: 2, d: 5 } }, position: "above", shape: "arrowDown", text: "Earnings call", color: "#f00", symbol: "NASDAQ:AAPL" },
      { time: { date: { y: 2026, m: 2, d: 6 } }, position: "below", shape: "arrowUp" },
      { time: { date: { y: 2026, m: 2, d: 9 } }, position: "inBar", shape: "square" },
    ]);
    expect(c.highlights.map((h) => [h.label, h.to])).toEqual([["Rally", { date: { y: 2026, m: 2, d: 10 } }], [undefined, { date: { y: 2026, m: 2, d: 11 } }]]);
    // A span needs both ends.
    expect([c.from, c.to]).toEqual([undefined, undefined]);
    expect(c.layout).toBe("2h");
    expect(parseEmbedConfig({ layout: "toString" }).layout).toBeUndefined();
    const many = Array.from({ length: MAX_MARKERS + 5 }, () => ({ time: 1773484200 }));
    expect(parseEmbedConfig({ markers: many }).markers).toHaveLength(MAX_MARKERS);
  });

  it("puts a mark on its bar", () => {
    expect(markerBar(days, { date: { y: 2026, m: 2, d: 5 } }, daily)).toBe(3);
    // A weekend has no bar; an instant on daily bars is its exchange date.
    expect(markerBar(days, { date: { y: 2026, m: 2, d: 7 } }, daily)).toBe(-1);
    expect(markerBar(days, { sec: at(10, 2, 0) }, daily)).toBe(5); // 22:00 on 09/03 in New York
    expect(markerBar(days, { wall: { y: 2026, m: 2, d: 9, minutes: 600 } }, daily)).toBe(5);
    // Weekly bars: the week holding the date.
    expect(markerBar(weeks, { date: { y: 2026, m: 2, d: 11 } }, weekly)).toBe(1);
    expect(markerBar(weeks, { date: { y: 2026, m: 2, d: 30 } }, weekly)).toBe(-1);
    // Intraday: a date is its first bar, an exchange time the bar holding it.
    expect(markerBar(bars5, { date: { y: 2026, m: 2, d: 13 } }, m5)).toBe(78);
    expect(markerBar(bars5, { wall: { y: 2026, m: 2, d: 12, minutes: 10 * 60 + 2 } }, m5)).toBe(6);
    // After the close: the day's last bar; past the last loaded bar or before the first: none.
    expect(markerBar(bars5, { wall: { y: 2026, m: 2, d: 12, minutes: 18 * 60 } }, m5)).toBe(77);
    expect(markerBar(bars5, { wall: { y: 2026, m: 2, d: 13, minutes: 18 * 60 } }, m5)).toBe(-1);
    expect(markerBar(bars5, { date: { y: 2026, m: 2, d: 11 } }, m5)).toBe(-1);
  });

  it("covers a period's bars", () => {
    expect(highlightBars(days, { from: { date: { y: 2026, m: 2, d: 4 } }, to: { date: { y: 2026, m: 2, d: 10 } } }, daily)).toEqual({ first: 2, last: 6 });
    // Ends given the wrong way round; a period starting before the loaded bars.
    expect(highlightBars(days, { from: { date: { y: 2026, m: 2, d: 10 } }, to: { date: { y: 2026, m: 2, d: 4 } } }, daily)).toEqual({ first: 2, last: 6 });
    expect(highlightBars(days, { from: { date: { y: 2026, m: 1, d: 1 } }, to: { date: { y: 2026, m: 2, d: 3 } } }, daily)).toEqual({ first: 0, last: 1 });
    expect(highlightBars(days, { from: { date: { y: 2026, m: 2, d: 7 } }, to: { date: { y: 2026, m: 2, d: 8 } } }, daily)).toBeNull();
    // A day on intraday bars: all its bars; exchange times: the bars holding them.
    expect(highlightBars(bars5, { from: { date: { y: 2026, m: 2, d: 13 } }, to: { date: { y: 2026, m: 2, d: 13 } } }, m5)).toEqual({ first: 78, last: 155 });
    expect(
      highlightBars(bars5, { from: { wall: { y: 2026, m: 2, d: 12, minutes: 600 } }, to: { wall: { y: 2026, m: 2, d: 12, minutes: 611 } } }, m5),
    ).toEqual({ first: 6, last: 8 });
  });

  it("frames a span in the chart's terms", () => {
    expect(frameSpan({ date: { y: 2026, m: 2, d: 12 } }, { date: { y: 2026, m: 2, d: 12 } }, m5)).toEqual({ from: at(12, 4, 0), to: at(13, 4, 0) - 1 });
  });

  it("shows a mark on its symbol's chart only", () => {
    expect([onChart(undefined, "NASDAQ:AAPL"), onChart("NASDAQ:AAPL", "nasdaq:aapl"), onChart("NYSE:IBM", "NASDAQ:AAPL")]).toEqual([true, true, false]);
  });

  it("opens a layout with one symbol per chart", () => {
    const tab = embedSeedTab(parseEmbedConfig({ layout: "3h", symbol: "NYSE:IBM", symbols: "NASDAQ:AAPL,NASDAQ:MSFT", compare: "NASDAQ:MSFT" }));
    expect(tab.layout).toBe("3h");
    expect(tab.panes.map((p) => p.symbol)).toEqual(["NASDAQ:AAPL", "NASDAQ:MSFT", "NYSE:IBM"]);
    expect(tab.panes.map((p) => p.compare?.length ?? 0)).toEqual([1, 0, 1]);
    expect([tab.sync?.interval, tab.sync?.dateRange, tab.sync?.symbol]).toEqual([true, true, false]);
    // Without a layout, the symbols are not the chart's.
    expect(embedSeedTab(parseEmbedConfig({ symbol: "NYSE:IBM", symbols: "NASDAQ:AAPL" })).panes.map((p) => p.symbol)).toEqual(["NYSE:IBM"]);
  });
});
