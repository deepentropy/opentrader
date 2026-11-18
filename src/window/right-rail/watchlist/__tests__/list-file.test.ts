import { describe, expect, it } from "vitest";
import { listFileTooBig, parseWatchlistFile } from "../list-file";

const tickers = (r: ReturnType<typeof parseWatchlistFile>) => {
  if ("error" in r) throw new Error(r.error);
  return { extras: r.extras.map((x) => x.ticker), groups: r.groups.map((g) => [g.name, ...g.rows.map((x) => x.ticker)]) };
};

describe("parseWatchlistFile", () => {
  it("splits on commas, tabs and new lines, not spaces", () => {
    expect(tickers(parseWatchlistFile("aapl,NASDAQ:MSFT\tf\r\nAmerican Depositary Shares\n"))).toEqual({
      extras: ["AAPL", "NASDAQ:MSFT", "F", "AMERICAN DEPOSITARY SHARES"],
      groups: [],
    });
  });

  it("reads ### items as sections, on their own line or among the symbols", () => {
    expect(tickers(parseWatchlistFile("SPY,###Tech,AAPL,MSFT\n###Empty\n### Banks\nJPM,AAPL"))).toEqual({
      extras: ["SPY"],
      groups: [["TECH", "AAPL", "MSFT"], ["BANKS", "JPM"]],
    });
  });

  it("refuses a binary or empty file", () => {
    expect(parseWatchlistFile("PK\u0003\u0004")).toEqual({ error: "format" });
    expect(parseWatchlistFile(",\r\n\t,")).toEqual({ error: "format" });
  });

  it("refuses more than 1000 items", () => {
    const list = (n: number) => Array.from({ length: n }, (_, i) => `T${i}`).join(",");
    expect("error" in parseWatchlistFile(list(1000))).toBe(false);
    expect(parseWatchlistFile(list(1001))).toEqual({ error: "count" });
  });

  it("does not read a file over 250 KB", () => {
    expect(listFileTooBig(250 * 1024)).toBe(false);
    expect(listFileTooBig(250 * 1024 + 1)).toBe(true);
  });
});
