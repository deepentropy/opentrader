import { describe, expect, it } from "vitest";
import { buildXlsx, columnName, crc32, sheetXml, zipStored } from "../xlsx-writer";
import { REPLAY_TABS, STRATEGY_TABS, excelDate, excelDateFormat, reportSheets, reportXlsxFileName, type XlsxReportContext } from "../xlsx-report";
import { ms, report, trade } from "./fixtures";
import type { BacktestReport } from "../../../backtester/types";

const enc = new TextEncoder();

/** Entry names of a stored zip (walks the local headers). */
function zipNames(z: Uint8Array): string[] {
  const v = new DataView(z.buffer, z.byteOffset, z.byteLength);
  const out: string[] = [];
  let at = 0;
  while (v.getUint32(at, true) === 0x04034b50) {
    const size = v.getUint32(at + 18, true);
    const n = v.getUint16(at + 26, true);
    out.push(new TextDecoder().decode(z.subarray(at + 30, at + 30 + n)));
    at += 30 + n + size;
  }
  return out;
}

function ctx(r: BacktestReport, interval = "1D"): XlsxReportContext {
  return { report: r, symbol: "NASDAQ:QQQ", interval, timeZone: "America/New_York", mintick: 0.01, pointValue: 1, priceCurrency: "USD" };
}

function sampleReport(): BacktestReport {
  const t = trade({
    qty: 1,
    profit: 12.46,
    profitPercent: 0.019127,
    cumProfit: 12.46,
    runUp: 13.09,
    runUpPercent: 0.0201,
    drawdown: 0,
    entry: { signal: "Buy market order", price: 651.42, time: ms(2026, 4, 23, 13, 30), bar: 0 },
    exit: { signal: "Close position", price: 663.88, time: ms(2026, 4, 24, 13, 30), bar: 1 },
  });
  const r = report([t], { capital: 1_000_000, netProfit: 12.46, netProfitPercent: 0.00001246, range: { from: ms(2026, 4, 23), to: ms(2026, 4, 24) } });
  const side = { netProfit: 12.46, netProfitPercent: 0.00001246, grossProfit: 12.46, totalTrades: 1, numberOfWiningTrades: 1, percentProfitable: 1, profitFactor: null, maxContractsHeld: 1 };
  (r as unknown as { performance: Record<string, unknown> }).performance = {
    all: side,
    long: side,
    short: { netProfit: 0, totalTrades: 0, maxContractsHeld: 0 },
    openPL: 0,
    maxStrategyDrawDown: 0,
    buyHoldGainPercent: 0.0191,
  };
  (r as unknown as { properties: Record<string, unknown> }).properties = {
    initialCapital: 1_000_000,
    defaultQtyType: "fixed",
    defaultQtyValue: 1,
    pyramiding: 1,
    commissionValue: 0,
    marginLong: 0,
    marginShort: 100,
    slippage: 0,
    fillLimitsTicks: 0,
    processOrdersOnClose: false,
    barMagnifier: false,
  };
  return r;
}

describe("xlsx writer", () => {
  it("CRC-32 of the standard check string", () => {
    expect(crc32(enc.encode("123456789"))).toBe(0xcbf43926);
  });

  it("stored zip: entries, sizes and the end record", () => {
    const z = zipStored([
      { name: "a.txt", data: enc.encode("hello") },
      { name: "b/c.xml", data: enc.encode("<x/>") },
    ]);
    expect(zipNames(z)).toEqual(["a.txt", "b/c.xml"]);
    const v = new DataView(z.buffer);
    const end = z.length - 22;
    expect(v.getUint32(end, true)).toBe(0x06054b50);
    expect(v.getUint16(end + 10, true)).toBe(2);
    // The central directory starts where the end record says.
    expect(v.getUint32(v.getUint32(end + 16, true), true)).toBe(0x02014b50);
    // CRC in the local header.
    expect(v.getUint32(14, true)).toBe(crc32(enc.encode("hello")));
  });

  it("workbook parts", () => {
    const z = buildXlsx([{ name: "Performance", rows: [["", "All USD"], ["Net profit", 12.46]] }]);
    expect(zipNames(z)).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "xl/workbook.xml",
      "xl/_rels/workbook.xml.rels",
      "xl/styles.xml",
      "xl/worksheets/sheet1.xml",
    ]);
  });

  it("sheet XML: text, numbers, formatted numbers, empty cells skipped", () => {
    const xml = sheetXml({ name: "S", rows: [["a & b", 1.5, { v: 46135, z: "yyyy-mm-dd" }, "", null]], widths: [6, 4] }, () => 1);
    expect(xml).toContain('<cols><col min="1" max="1" width="6" customWidth="1"/><col min="2" max="2" width="4" customWidth="1"/></cols>');
    expect(xml).toContain('<c r="A1" t="inlineStr"><is><t xml:space="preserve">a &amp; b</t></is></c>');
    expect(xml).toContain('<c r="B1"><v>1.5</v></c><c r="C1" s="1"><v>46135</v></c></row>');
    expect(columnName(0)).toBe("A");
    expect(columnName(25)).toBe("Z");
    expect(columnName(26)).toBe("AA");
  });
});

describe("report workbook (reference layout)", () => {
  it("sheets of the Strategy Tester and of Replay Trading", () => {
    const r = sampleReport();
    expect(reportSheets(ctx(r), STRATEGY_TABS).map((s) => s.name)).toEqual(["Performance", "Trades analysis", "Risk-adjusted performance", "Trades", "Properties"]);
    expect(reportSheets(ctx(r), REPLAY_TABS).map((s) => s.name)).toEqual(["Performance", "Trades analysis", "Risk-adjusted performance", "Trades"]);
  });

  it("metric rows: value and percent columns per side", () => {
    const [perf, analysis, ratios] = reportSheets(ctx(sampleReport()), STRATEGY_TABS);
    expect(perf.rows[0]).toEqual(["", "All USD", "All %", "Long USD", "Long %", "Short USD", "Short %"]);
    expect(perf.rows[1]).toEqual(["Initial capital", 1_000_000, "", "", "", "", ""]);
    const net = perf.rows.find((r) => r[0] === "Net profit")!;
    expect(net.slice(1, 5)).toEqual([12.46, { v: 0, z: "0.00" }, 12.46, { v: 0, z: "0.00" }]);
    // A percent field: only the % column.
    expect(perf.rows.find((r) => r[0] === "Buy and hold % gain")!.slice(1, 3)).toEqual(["", { v: 1.91, z: "0.00" }]);
    expect(analysis.rows.find((r) => r[0] === "Percent profitable")!.slice(1, 3)).toEqual(["", { v: 100, z: "0.00" }]);
    expect(analysis.rows.find((r) => r[0] === "Total trades")!.slice(1)).toEqual([1, "", 1, "", 0, ""]);
    expect(ratios.rows.map((r) => r[0])).toEqual(["", "Sharpe ratio", "Sortino ratio", "Profit factor", "Margin calls"]);
  });

  it("trades: exit row then entry row, Excel dates, percents", () => {
    const [, , , trades] = reportSheets(ctx(sampleReport()), STRATEGY_TABS);
    expect(trades.rows[0][2]).toBe("Date and time");
    const [exit, entry] = trades.rows.slice(1);
    expect(exit.slice(0, 2)).toEqual([1, "Exit long"]);
    expect(exit[2]).toEqual({ v: excelDate(ms(2026, 4, 24, 13, 30), "1D", "America/New_York"), z: "yyyy-mm-dd" });
    expect(exit.slice(3, 5)).toEqual(["Close position", 663.88]);
    expect(entry.slice(3, 5)).toEqual(["Buy market order", 651.42]);
    expect(exit[7]).toBe(12.46);
    expect(exit[8]).toEqual({ v: 1.91, z: "0.00" });
    // Date column width: the date format.
    expect(trades.widths![2]).toBe("yyyy-mm-dd".length + 1);
  });

  it("properties", () => {
    const props = reportSheets(ctx(sampleReport()), STRATEGY_TABS)[4];
    expect(props.rows[0]).toEqual(["name", "value"]);
    const map = Object.fromEntries(props.rows.slice(1).map((r) => [r[0], r[1]]));
    expect(map["Symbol"]).toBe("NASDAQ:QQQ");
    expect(map["Initial capital"]).toBe("1000000");
    expect(map["Default order size"]).toBe("1 contracts");
    expect(map["Pyramiding"]).toBe("1 orders");
    expect(map["Long leverage"]).toBe("Infinity");
    expect(map["Short leverage"]).toBe("1x");
    expect(map["Slippage"]).toBe("0 ticks");
    expect(map["Order execution delay"]).toBe("One tick");
    expect(map["Script execution"]).toBe("On bar close");
  });

  it("Excel dates and file name", () => {
    // 2026-04-24 09:30 New York = serial 46136.395833...
    expect(excelDate(ms(2026, 4, 24, 13, 30), "5", "America/New_York")).toBeCloseTo(46136 + 9.5 / 24, 9);
    expect(excelDate(ms(2026, 4, 24, 13, 30), "1D", "America/New_York")).toBe(46136);
    expect(excelDateFormat("5")).toBe("yyyy-mm-dd hh:mm");
    expect(excelDateFormat("30S")).toBe("yyyy-mm-dd hh:mm:ss");
    expect(reportXlsxFileName("Replay Trading", "NASDAQ:QQQ", new Date(2026, 9, 21))).toBe("Replay_Trading_NASDAQ_QQQ_2026-10-21.xlsx");
  });
});
