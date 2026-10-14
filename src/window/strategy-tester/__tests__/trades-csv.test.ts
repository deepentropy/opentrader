import { describe, expect, it } from "vitest";
import { general, tradesCsv, tradesCsvFileName, type CsvContext } from "../trades-csv";
import { ms, trade } from "./fixtures";

describe("general (SheetJS General number format)", () => {
  it("integers as is", () => {
    expect(general(5)).toBe("5");
    expect(general(-42)).toBe("-42");
    expect(general(0)).toBe("0");
  });

  it("decimals without trailing zeros", () => {
    expect(general(0.1)).toBe("0.1");
    expect(general(-0.5)).toBe("-0.5");
    expect(general(1234.5678)).toBe("1234.5678");
    expect(general(10 * 100.123)).toBe("1001.23");
    expect(general(1 / 3)).toBe("0.333333333");
    expect(general(1e-7)).toBe("0.0000001");
  });

  it("long numbers fall back to 10 significant digits", () => {
    expect(general(123456789.123)).toBe("123456789.1");
  });

  it("non-finite values", () => {
    expect(general(Number.NaN)).toBe("#NUM!");
    expect(general(Infinity)).toBe("#DIV/0!");
  });
});

describe("tradesCsv", () => {
  const closed = trade({
    direction: "long",
    qty: 10,
    profit: 98.77,
    profitPercent: 0.0987,
    commission: 1,
    runUp: 120,
    runUpPercent: 0.12,
    drawdown: 30,
    drawdownPercent: 0.03,
    cumProfit: 98.77,
    entry: { signal: "Long", price: 100.123, bar: 0, time: ms(2026, 1, 5, 14, 30) },
    exit: { signal: "Exit", price: 110, bar: 5, time: ms(2026, 1, 12, 14, 30) },
  });
  const open = trade({
    direction: "short",
    open: true,
    qty: 2,
    profit: 4,
    profitPercent: 0.04,
    commission: 0,
    runUp: 5,
    runUpPercent: 0.05,
    drawdown: 1,
    drawdownPercent: 0.01,
    cumProfit: 102.77,
    entry: { signal: "Short, big", price: 50, bar: 6, time: ms(2026, 1, 13, 14, 30) },
    exit: { signal: "", price: 48, bar: 9, time: ms(2026, 1, 16, 14, 30) },
  });
  const ctx = (over: Partial<CsvContext> = {}): CsvContext => ({
    trades: [closed, open],
    currency: "USD",
    priceCurrency: "USD",
    initialCapital: 10_000,
    mintick: 0.01,
    pointValue: 1,
    timeZone: "America/New_York",
    interval: "1D",
    ...over,
  });

  it("matches the reference file layout byte for byte", () => {
    const csv = tradesCsv(ctx());
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv.endsWith("\n")).toBe(false);
    expect(csv.slice(1).split("\n")).toEqual([
      "Trade number,Type,Date and time,Signal,Price USD,Size (qty),Size (value),Net PnL USD,Return %,Commission USD,Favorable excursion USD,Favorable excursion %,Adverse excursion USD,Adverse excursion %,Cumulative PnL USD,Cumulative PnL %,Duration (bars)",
      "1,Exit long,2026-01-12,Exit,110,10,1001.23,98.77,9.87,1,120,12.00,-30,-3.00,98.77,0.99,5",
      "1,Entry long,2026-01-05,Long,100.12,10,1001.23,98.77,9.87,1,120,12.00,-30,-3.00,98.77,0.99,5",
      "2,Exit short,Open,Open,—,2,100,4,4.00,0,5,5.00,-1,-1.00,102.77,1.03,3",
      '2,Entry short,2026-01-13,"Short, big",50,2,100,4,4.00,0,5,5.00,-1,-1.00,102.77,1.03,3',
    ]);
  });

  it("intraday and seconds charts carry the time in the chart zone", () => {
    const row = (interval: string) => tradesCsv(ctx({ interval, trades: [closed] })).split("\n")[2].split(",")[2];
    expect(row("5")).toBe("2026-01-05 09:30");
    expect(row("30S")).toBe("2026-01-05 09:30:00");
    expect(row("1W")).toBe("2026-01-05");
    expect(row(" 1m ")).toBe("2026-01-05");
  });

  it("prices round to the symbol tick", () => {
    const row = tradesCsv(ctx({ mintick: 0.25, trades: [closed] })).split("\n")[2].split(",");
    expect(row[4]).toBe("100.1"); // 1 decimal for a 0.25 tick
    const row4 = tradesCsv(ctx({ mintick: 0.0001, trades: [closed] })).split("\n")[2].split(",");
    expect(row4[4]).toBe("100.123");
  });

  it("small money values keep their first significant decimal; tiny percents print 0.00", () => {
    const t = trade({ commission: 0.004, profit: -0.00001, profitPercent: -0.0000001, cumProfit: 0 });
    const row = tradesCsv(ctx({ trades: [t] })).split("\n")[1].split(",");
    expect(row[9]).toBe("0.004");
    expect(row[7]).toBe("-0.00001");
    expect(row[8]).toBe("0.00");
  });

  it("a trade closed at price 0 has an empty return; no capital gives 0.00 cumulative", () => {
    const t = trade({ profitPercent: Number.NaN });
    const row = tradesCsv(ctx({ trades: [t], initialCapital: 0 })).split("\n")[1].split(",");
    expect(row[8]).toBe("");
    expect(row[15]).toBe("0.00");
  });

  it("no trades: header only", () => {
    expect(tradesCsv(ctx({ trades: [] })).slice(1).split("\n")).toHaveLength(1);
  });
});

describe("tradesCsvFileName", () => {
  it("short title with _ for spaces, symbol with : as _, local date", () => {
    expect(tradesCsvFileName("Supertrend Strategy", "NASDAQ:GTLB", new Date(2026, 9, 4))).toBe("Supertrend_Strategy_NASDAQ_GTLB_2026-10-04.csv");
    expect(tradesCsvFileName('A/B "x"', "T", new Date(2026, 0, 1))).toBe("A_B__x__T_2026-01-01.csv");
  });
});
