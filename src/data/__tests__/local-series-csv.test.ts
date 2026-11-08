import { describe, expect, it } from "vitest";
import { detectBase, parseBarsCsv, parseSeedSymbolInfo, parseTime, seriesNameFromFile } from "../local-series-csv";

const NY = "America/New_York";
const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 1000;

describe("parseTime", () => {
  it("reads UNIX seconds and ms, ISO with an offset, and wall times in the zone", () => {
    expect(parseTime("1704205800", NY)).toEqual({ sec: 1704205800, dateOnly: false });
    expect(parseTime("1704205800000", NY)).toEqual({ sec: 1704205800, dateOnly: false });
    expect(parseTime("2024-01-02T09:30:00-05:00", "Etc/UTC")?.sec).toBe(1704205800);
    expect(parseTime("2024-01-02 09:30", NY)?.sec).toBe(1704205800);
    expect(parseTime("2024-01-02", NY)).toEqual({ sec: day("2024-01-02") + 5 * 3600, dateOnly: true });
    expect(parseTime("20210101T", "Etc/UTC")).toEqual({ sec: day("2021-01-01"), dateOnly: true });
    expect(parseTime("02.01.2024 09:30:00.000", "Etc/UTC", "dmy")?.sec).toBe(day("2024-01-02") + 9.5 * 3600);
    expect(parseTime("open", NY)).toBeNull();
  });
});

describe("seriesNameFromFile", () => {
  it("makes a valid ticker of a file name", () => {
    expect(seriesNameFromFile("C:/data/btc dev activity.csv")).toBe("BTC_DEV_ACTIVITY");
    expect(seriesNameFromFile("NASDAQ_AAPL, 1D.csv")).toBe("NASDAQ_AAPL_1D");
    expect(seriesNameFromFile("???.csv")).toBe("SERIES");
  });
});

describe("detectBase", () => {
  it("finds the bar size", () => {
    expect(detectBase([0, 300, 900, 1200], false, "Etc/UTC")).toBe("5");
    expect(detectBase([0, 30, 60, 120], false, "Etc/UTC")).toBe("30S");
    expect(detectBase([0, 86400, 3 * 86400], false, "Etc/UTC")).toBe("1D");
    expect(detectBase([0, 86400], true, "Etc/UTC")).toBe("1D");
    // Daily bars at New York midnight around the March DST change (a 23-hour day).
    const t0 = parseTime("2024-03-09", NY)!.sec;
    const t1 = parseTime("2024-03-10", NY)!.sec;
    const t2 = parseTime("2024-03-11", NY)!.sec;
    expect(detectBase([t0, t1, t2], false, "Etc/UTC")).toBe("1D");
  });
});

describe("parseBarsCsv", () => {
  it("reads the app's own export (header, UNIX time, extra study columns)", () => {
    const csv = "time,open,high,low,close,Volume,Volume MA\n1704205800,1,2,0.5,1.5,100,\n1704206100,1.5,2.25,1,2,200,150";
    const r = parseBarsCsv(csv, NY);
    expect(r.base).toBe("5");
    expect(r.hasVolume).toBe(true);
    expect(r.pricescale).toBe(100);
    expect(r.rows).toEqual([1704205800, 1, 2, 0.5, 1.5, 100, 1704206100, 1.5, 2.25, 1, 2, 200]);
  });

  it("reads the Pine Seeds layout (no header, YYYYMMDDT)", () => {
    const r = parseBarsCsv("20210101T,10,12,9,11,0\n20210102T,11,13,10,12.5,0\n", "Etc/UTC");
    expect(r.base).toBe("1D");
    expect(r.hasVolume).toBe(false);
    expect(r.rows.slice(0, 6)).toEqual([day("2021-01-01"), 10, 12, 9, 11, 0]);
  });

  it("reads a date and a time column, tab separated, with tick volume when volume is all zeros", () => {
    const csv = "<DATE>\t<TIME>\t<OPEN>\t<HIGH>\t<LOW>\t<CLOSE>\t<TICKVOL>\t<VOL>\n2024.01.02\t00:00\t1.1\t1.2\t1.0\t1.15\t50\t0\n2024.01.02\t00:01\t1.15\t1.25\t1.1\t1.2\t60\t0";
    const r = parseBarsCsv(csv, "Etc/UTC");
    expect(r.base).toBe("1");
    expect(r.rows[5]).toBe(50);
    expect(r.rows[6]).toBe(day("2024-01-02") + 60);
  });

  it("reads a single value column, sorts, keeps the last of a repeated time, and fixes high / low", () => {
    const csv = "DATE,UNRATE\n2024-02-01,3.9\n2024-01-01,3.7\n2024-01-01,3.8";
    const r = parseBarsCsv(csv, "Etc/UTC");
    expect(r.rows).toEqual([day("2024-01-01"), 3.8, 3.8, 3.8, 3.8, 0, day("2024-02-01"), 3.9, 3.9, 3.9, 3.9, 0]);
    const bad = parseBarsCsv("time,open,high,low,close\n2024-01-01,5,4,6,5.5", "Etc/UTC");
    expect(bad.rows.slice(1, 5)).toEqual([5, 6, 4, 5.5]);
  });

  it("stamps daily bars written with a time at their local midnight", () => {
    const r = parseBarsCsv("Date,Open,High,Low,Close,Adj Close,Volume\n2024-01-02 16:00,1,2,0.5,1.5,1.4,10\n2024-01-03 16:00,1,2,0.5,1.5,1.4,10", NY);
    expect(r.base).toBe("1D");
    expect(r.rows[0]).toBe(parseTime("2024-01-02", NY)!.sec);
  });

  it("counts lines that are not bars and refuses a file of none", () => {
    expect(parseBarsCsv("time,close\n2024-01-01,1\noops,2\n2024-01-02,3", "Etc/UTC").skipped).toBe(1);
    expect(() => parseBarsCsv("", "Etc/UTC")).toThrow();
    expect(() => parseBarsCsv("a,b,c\nx,y,z", "Etc/UTC")).toThrow();
  });
});

describe("parseSeedSymbolInfo", () => {
  it("reads per-symbol arrays and shared values", () => {
    const m = parseSeedSymbolInfo('{"symbol":["A","b"],"description":["Alpha","Beta"],"pricescale":100}');
    expect(m.get("A")).toEqual({ description: "Alpha", pricescale: 100 });
    expect(m.get("B")).toEqual({ description: "Beta", pricescale: 100 });
  });
});
