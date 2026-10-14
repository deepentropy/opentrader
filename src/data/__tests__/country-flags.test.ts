import { describe, expect, it } from "vitest";
import { countryOfExchange, flagUrl } from "../country-flags";

describe("countryOfExchange", () => {
  it("US exchanges by name or code, any case", () => {
    for (const ex of ["NASDAQ", "nyse", "NYSE ARCA", "AMEX", "CBOE BZX", "IEX", "OTC", "BOATS"]) expect(countryOfExchange(ex), ex).toBe("US");
  });

  it("unknown otherwise", () => {
    expect(countryOfExchange("LSE")).toBeUndefined();
    expect(countryOfExchange("")).toBeUndefined();
    expect(countryOfExchange(undefined)).toBeUndefined();
  });
});

describe("flagUrl", () => {
  it("is undefined without a country or for a country the set does not have", () => {
    expect(flagUrl(undefined)).toBeUndefined();
    expect(flagUrl("")).toBeUndefined();
    expect(flagUrl("ZZZ")).toBeUndefined();
  });
});
