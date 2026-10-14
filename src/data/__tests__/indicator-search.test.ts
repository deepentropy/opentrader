import { describe, expect, it } from "vitest";
import { highlightParts, rankRows, type Searchable } from "../indicator-search";

const ROWS: Searchable[] = [
  { name: "Relative strength index", shortName: "RSI" },
  { name: "Moving average", shortName: "MA" },
  { name: "Moving average exponential", shortName: "EMA" },
  { name: "Stochastic RSI", shortName: "Stoch RSI" },
  { name: "Relative vigor index", shortName: "RVI" },
  { name: "Price volume trend" },
];
const names = (rows: Searchable[]) => rows.map((r) => r.shortName ?? r.name);

describe("rankRows", () => {
  it("returns the rows unchanged for an empty query", () => {
    expect(rankRows(ROWS, "")).toBe(ROWS);
    expect(rankRows(ROWS, "   ")).toBe(ROWS);
  });

  it("ranks an equal short name first, then short names containing the query", () => {
    expect(names(rankRows(ROWS, "rsi"))).toEqual(["RSI", "Stoch RSI"]);
    expect(names(rankRows(ROWS, "ma"))).toEqual(["MA", "EMA"]);
  });

  it("is case-insensitive and trims the query", () => {
    expect(names(rankRows(ROWS, "  RsI "))).toEqual(["RSI", "Stoch RSI"]);
  });

  it("matches the name, or word initials read from its start", () => {
    expect(names(rankRows(ROWS, "vigor"))).toEqual(["RVI"]);
    expect(names(rankRows(ROWS, "pvt"))).toEqual(["Price volume trend"]);
    expect(names(rankRows(ROWS, "rvi"))).toEqual(["RVI"]);
    // Initials must start at the first word ("strength index" is not "si").
    expect(rankRows([{ name: "Relative strength index" }], "si")).toEqual([]);
    expect(rankRows([{ name: "Relative strength index" }], "rs")).toHaveLength(1);
  });

  it("drops rows that match nothing", () => {
    expect(rankRows(ROWS, "zzz")).toEqual([]);
  });

  it("breaks ties by match position, then list order", () => {
    const rows: Searchable[] = [{ name: "X", shortName: "ZZMA" }, { name: "Y", shortName: "MAZZ" }, { name: "W", shortName: "ZMA" }, { name: "V", shortName: "MAZ" }];
    expect(names(rankRows(rows, "ma"))).toEqual(["MAZZ", "MAZ", "ZMA", "ZZMA"]);
  });

  it("a short-name hit beats a name hit, an initials hit ranks with name hits", () => {
    const rows: Searchable[] = [
      { name: "Bollinger bands", shortName: "BB" },
      { name: "Bollinger bands %B", shortName: "BB %B" },
      { name: "Bull bear power", shortName: "BBP" },
      { name: "Big bucks" },
    ];
    expect(names(rankRows(rows, "bb"))).toEqual(["BB", "BB %B", "BBP", "Big bucks"]);
  });

  it("word starts include '/' and '-'", () => {
    const rows: Searchable[] = [{ name: "Price/volume trend" }, { name: "Know-sure thing" }];
    expect(names(rankRows(rows, "pvt"))).toEqual(["Price/volume trend"]);
    expect(names(rankRows(rows, "kst"))).toEqual(["Know-sure thing"]);
  });
});

describe("highlightParts", () => {
  it("marks the contained text", () => {
    expect(highlightParts("Moving average", "aver")).toEqual([
      { text: "Moving ", hit: false },
      { text: "aver", hit: true },
      { text: "age", hit: false },
    ]);
    expect(highlightParts("RSI", "rsi")).toEqual([{ text: "RSI", hit: true }]);
  });

  it("marks word initials from the start", () => {
    expect(highlightParts("Relative strength index", "rsi")).toEqual([
      { text: "R", hit: true },
      { text: "elative ", hit: false },
      { text: "s", hit: true },
      { text: "trength ", hit: false },
      { text: "i", hit: true },
      { text: "ndex", hit: false },
    ]);
  });

  it("falls back to initials from any word", () => {
    expect(highlightParts("Relative strength index", "si")).toEqual([
      { text: "Relative ", hit: false },
      { text: "s", hit: true },
      { text: "trength ", hit: false },
      { text: "i", hit: true },
      { text: "ndex", hit: false },
    ]);
  });

  it("no highlight without a query or a match", () => {
    expect(highlightParts("abc", "")).toEqual([{ text: "abc", hit: false }]);
    expect(highlightParts("abc", "  ")).toEqual([{ text: "abc", hit: false }]);
    expect(highlightParts("abc", "zz")).toEqual([{ text: "abc", hit: false }]);
    expect(highlightParts("", "x")).toEqual([]);
  });
});
