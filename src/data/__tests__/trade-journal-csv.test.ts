import { describe, expect, it } from "vitest";
import {
  buildStrategyTesterTrades,
  buildTrades,
  detectDateOrder,
  detectDelimiter,
  guessMapping,
  isStrategyTesterExport,
  parseClock,
  parseCsv,
  parseNumber,
  parseSide,
  parseStamp,
} from "../trade-journal-csv";

describe("parseCsv", () => {
  it("reads quotes, CRLF, BOM and skips blank lines", () => {
    const rows = parseCsv('﻿a,b\r\n"x, y","say ""hi"""\r\n\r\n1,2');
    expect(rows).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"'],
      ["1", "2"],
    ]);
  });
  it("detects ; and tab delimiters", () => {
    expect(detectDelimiter("a;b;c\n1;2;3")).toBe(";");
    expect(detectDelimiter("a\tb\n1\t2")).toBe("\t");
    expect(detectDelimiter('"a,b";c')).toBe(";");
  });
});

describe("guessMapping", () => {
  it("maps common broker headers", () => {
    const m = guessMapping(["Ticker", "Side", "Open Date", "Close Date", "Shares", "Entry Price", "Exit Price", "Commission", "Notes"]);
    expect(m).toEqual({ symbol: 0, side: 1, entry: 2, exit: 3, qty: 4, entryPrice: 5, exitPrice: 6, fees: 7, notes: 8 });
  });
  it("maps entry/exit time headers", () => {
    const m = guessMapping(["symbol", "entry_time", "exit_time"]);
    expect(m).toMatchObject({ symbol: 0, entry: 1, exit: 2 });
  });
});

describe("parseStamp", () => {
  it("reads ISO dates and times", () => {
    expect(parseStamp("2024-01-05")).toEqual({ kind: "wall", y: 2024, m: 0, d: 5, h: 0, mi: 0, s: 0, dateOnly: true });
    expect(parseStamp("2024-01-05 09:35:10")).toMatchObject({ h: 9, mi: 35, s: 10, dateOnly: false });
    expect(parseStamp("2024-01-05T14:30:00Z")).toEqual({ kind: "utc", sec: Date.UTC(2024, 0, 5, 14, 30) / 1000, dateOnly: false });
    expect(parseStamp("2024-01-05T09:30:00-05:00")).toEqual({ kind: "utc", sec: Date.UTC(2024, 0, 5, 14, 30) / 1000, dateOnly: false });
  });
  it("reads numeric dates in the given order, with AM/PM", () => {
    expect(parseStamp("05/01/2024", "dmy")).toMatchObject({ y: 2024, m: 0, d: 5 });
    expect(parseStamp("05/01/2024", "mdy")).toMatchObject({ y: 2024, m: 4, d: 1 });
    expect(parseStamp("1/5/24 3:45 PM", "mdy")).toMatchObject({ y: 2024, m: 0, d: 5, h: 15, mi: 45 });
    expect(parseStamp("20240105")).toMatchObject({ y: 2024, m: 0, d: 5, dateOnly: true });
  });
  it("reads month names and epochs", () => {
    expect(parseStamp("5 Jan 2024")).toMatchObject({ y: 2024, m: 0, d: 5 });
    expect(parseStamp("Jan 5, 2024 10:00")).toMatchObject({ y: 2024, m: 0, d: 5, h: 10 });
    expect(parseStamp("1704465000")).toEqual({ kind: "utc", sec: 1704465000, dateOnly: false });
    expect(parseStamp("1704465000000")).toEqual({ kind: "utc", sec: 1704465000, dateOnly: false });
  });
  it("rejects invalid dates", () => {
    expect(parseStamp("2024-02-30")).toBeNull();
    expect(parseStamp("13/13/2024", "dmy")).toBeNull();
    expect(parseStamp("soon")).toBeNull();
  });
});

describe("values", () => {
  it("detects the day/month order", () => {
    expect(detectDateOrder(["05/01/2024", "25/01/2024"])).toBe("dmy");
    expect(detectDateOrder(["01/25/2024"])).toBe("mdy");
    expect(detectDateOrder(["01/02/2024"])).toBeNull();
  });
  it("reads clocks, numbers and sides", () => {
    expect(parseClock("12:05 AM")).toBe(300);
    expect(parseClock("9:30")).toBe(9 * 3600 + 1800);
    expect(parseClock("25:00")).toBeNull();
    expect(parseNumber("$1,234.50")).toBe(1234.5);
    expect(parseNumber("(12.30)")).toBe(-12.3);
    expect(parseNumber("1.234,5", true)).toBe(1234.5);
    expect(parseNumber("—")).toBeNull();
    expect(parseSide("Short")).toBe("short");
    expect(parseSide("SELL")).toBe("short");
    expect(parseSide("Buy")).toBe("long");
    expect(parseSide("Limit")).toBeNull();
  });
});

describe("buildTrades", () => {
  it("builds trades and reports unreadable rows", () => {
    const rows = parseCsv("Symbol,Entry,Exit,Qty,Clock\naapl,15/03/2024,18/03/2024,-10,\nMSFT,bad,2024-01-02,5,\n,2024-01-01,2024-01-02,1,");
    const r = buildTrades(rows.slice(1), { symbol: 0, entry: 1, exit: 2, qty: 3 });
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0]).toMatchObject({ symbol: "AAPL", side: "short", qty: 10, entry: { y: 2024, m: 2, d: 15, dateOnly: true } });
    expect(r.errors.map((e) => e.row)).toEqual([3, 4]);
  });
  it("adds a separate time column and a default symbol", () => {
    const rows = [["2024-01-05", "09:31", "2024-01-05", "15:59"]];
    const r = buildTrades(rows, { entry: 0, entryClock: 1, exit: 2, exitClock: 3 }, { symbol: "spy" });
    expect(r.trades[0]).toMatchObject({ symbol: "SPY", entry: { h: 9, mi: 31, dateOnly: false }, exit: { h: 15, mi: 59, dateOnly: false } });
  });
});

describe("Strategy Tester export", () => {
  const csv = [
    "Trade number,Type,Date and time,Signal,Price USD,Size (qty),Size (value),Net PnL USD,Return %,Commission USD",
    "1,Exit long,2024-01-10 15:00,Close,105.5,10,1000,55,5.5,1",
    "1,Entry long,2024-01-05 10:00,Buy,100,10,1000,55,5.5,1",
    "2,Exit short,Open,Open,—,3,300,0,0,0",
    "2,Entry short,2024-02-01 10:00,Sell,90,3,270,0,0,0",
  ].join("\n");
  it("pairs entries and exits, leaving open trades out", () => {
    const rows = parseCsv(csv);
    expect(isStrategyTesterExport(rows[0])).toBe(true);
    const r = buildStrategyTesterTrades(rows[0], rows.slice(1), "nasdaq:aapl");
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0]).toMatchObject({
      symbol: "NASDAQ:AAPL",
      side: "long",
      qty: 10,
      entryPrice: 100,
      exitPrice: 105.5,
      fees: 1,
      notes: "Buy → Close",
      entry: { y: 2024, m: 0, d: 5, h: 10 },
      exit: { y: 2024, m: 0, d: 10, h: 15 },
    });
    expect(r.errors).toHaveLength(1);
  });
});
