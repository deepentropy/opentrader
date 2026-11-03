import { describe, expect, it } from "vitest";
import { csvFileName, screenCsv } from "../screener-csv";
import { scriptResultsCsv } from "../script-csv";

const C = (id: string, params: Record<string, string> = {}) => ({ id, params });

describe("screenCsv", () => {
  it("writes the reference format: Symbol, Description, titled columns, currency after money columns", () => {
    const columns = [C("Price"), C("Change", { resolution: "TimeResolution1D" }), C("Sector")];
    const fields = ["close", "change", "sector", "description", "currency"];
    const rows = [
      { s: "AFRM", d: [73.58, 0.14972097454743355, "Finance", "Affirm Holdings, Inc.", "usd"] },
      { s: "XYZ", d: [null, null, null, null, null] },
    ];
    expect(screenCsv(rows, columns, fields)).toBe(
      [
        'Symbol,Description,Price,Price - Currency,"Price change %, 1 day",Sector',
        'AFRM,"Affirm Holdings, Inc.",73.58,USD,0.14972097454743355,Finance',
        "XYZ,,,,,",
      ].join("\n"),
    );
  });

  it("names the file after the screen and the local date", () => {
    expect(csvFileName("Pullback", new Date(2026, 10, 3, 23, 30))).toBe("Pullback_2026-11-03.csv");
    expect(csvFileName("a/b:c")).toMatch(/^a_b_c_\d{4}-\d{2}-\d{2}\.csv$/);
  });
});

describe("scriptResultsCsv", () => {
  it("writes Symbol, Description and the columns, without the failed rows", () => {
    const csv = scriptResultsCsv(
      [
        { symbol: "NASDAQ:AAPL", cells: { "out:plot0": { value: 47.87 } } },
        { symbol: "NYSE:BAD", cells: {}, error: "No data" },
      ],
      [{ key: "out:plot0", title: "RSI", kind: "value" }],
      new Map([["AAPL", "Apple Inc."]]),
    );
    expect(csv).toBe("Symbol,Description,RSI\nAAPL,Apple Inc.,47.87");
  });
});
