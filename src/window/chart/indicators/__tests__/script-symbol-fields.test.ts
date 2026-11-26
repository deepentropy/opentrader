import { describe, expect, it, vi } from "vitest";

const infos: Record<string, object> = {
  "NASDAQ:AAPL": { name: "Apple Inc.", symbolType: "stock", currency: "USD", sector: "Manufacturing", industry: "ELECTRONIC COMPUTERS", totalEmployees: 167000, sharesOutstanding: 14.5e9 },
  "NFO:NIFTY1!": { name: "NIFTY continuous", symbolType: "futures", currency: "INR", currentContract: "NIFTY26DECFUT", root: "NIFTY", country: "IN" },
  "NFO:NIFTY26DECFUT": { name: "NIFTY Dec", symbolType: "futures", currency: "INR", expiration: "2026-12-29" },
  "MT5:EURUSD": { name: "Euro vs US Dollar", symbolType: "forex", currency: "USD" },
};
const plugin = { timeZone: "Asia/Kolkata", regularScript: { session: "0915-1530", corrections: "", holidays: "", barOrigin: null }, intervals: ["1D"] };
const server = { ...plugin, timeZone: "America/New_York", intervals: [] };

vi.mock("../../../../data/datafeed", () => ({
  getTickerInfo: async (s: string) => infos[s],
  isLocalSymbol: (s: string) => s.startsWith("LOCAL:"),
}));
vi.mock("../../../../data/session", () => ({
  cachedSymbolSessions: (s: string) => (s.startsWith("NASDAQ:") ? server : plugin),
}));

import { scriptSymbolFields, symbolDetailsLoaded } from "../script-chart";

async function fields(symbol: string) {
  await symbolDetailsLoaded(symbol);
  return scriptSymbolFields(symbol);
}

describe("scriptSymbolFields (#414)", () => {
  it("a server symbol: a US company; what it has no source for is left out", async () => {
    const f = await fields("NASDAQ:AAPL");
    expect(f).toMatchObject({
      description: "Apple Inc.", country: "US", volumetype: "n/a", basecurrency: null, currentContract: null, expirationDate: null,
      sector: "Manufacturing", industry: "Electronic Computers", employees: 167000, sharesOutstandingTotal: 14.5e9,
    });
    expect("isin" in f || "targetPrice" in f || "shareholders" in f).toBe(false);
  });

  it("a plugin's futures: root, contract, expiration at its session's open; no company figures", async () => {
    const c = await fields("NFO:NIFTY1!");
    expect(c).toMatchObject({ root: "NIFTY", currentContract: "NIFTY26DECFUT", expirationDate: null, country: "IN", sector: null, isin: null, targetPrice: null });
    const d = await fields("NFO:NIFTY26DECFUT");
    // 09:15 in Kolkata on 29/12/2026
    expect(d.expirationDate).toBe(Date.parse("2026-12-29T03:45Z"));
    expect(d.currentContract).toBeNull();
  });

  it("a plugin's forex pair: its base currency from the ticker, no country", async () => {
    expect(await fields("MT5:EURUSD")).toMatchObject({ basecurrency: "EUR", country: null, volumetype: "n/a" });
  });
});
