import { describe, expect, it } from "vitest";
import { EMBED_DEFAULTS, embedConfigFromHash, isEmbedView, parseEmbedConfig } from "../config";
import { embedSeedItems, MemoryStorage } from "../boot";
import { embedInterval, embedSeedTab } from "../seed";

describe("embed settings", () => {
  it("fills in the defaults", () => {
    expect(parseEmbedConfig(undefined)).toEqual(EMBED_DEFAULTS);
    expect(parseEmbedConfig("x")).toEqual(EMBED_DEFAULTS);
  });

  it("keeps valid values and drops the others", () => {
    const c = parseEmbedConfig({
      symbol: "nyse:ibm",
      interval: "D",
      range: "ytd",
      theme: "dark",
      locale: "fr",
      timezone: "Europe/Paris",
      allowSymbolChange: true,
      hideTopToolbar: "true",
      drawingToolbar: "",
      dateRanges: "false",
      studies: ["rsi", { id: "sma", inputs: { length: 50 } }, 3],
      compare: "NASDAQ:MSFT, bad, NASDAQ:MSFT",
      watchlist: ["NYSE:IBM", "AMEX:SPY"],
      popupWidth: 50,
      popupHeight: "800",
    });
    expect(c).toMatchObject({
      symbol: "NYSE:IBM",
      interval: "1D",
      range: "YTD",
      theme: "dark",
      locale: "fr",
      timezone: "Europe/Paris",
      allowSymbolChange: true,
      hideTopToolbar: true,
      drawingToolbar: true,
      dateRanges: false,
      studies: [{ id: "rsi" }, { id: "sma", inputs: { length: 50 } }],
      compare: ["NASDAQ:MSFT"],
      watchlist: ["NYSE:IBM", "AMEX:SPY"],
      popupWidth: 1000,
      popupHeight: 800,
    });
    expect(parseEmbedConfig({ symbol: "<script>", theme: "blue", interval: "1h", locale: "x" })).toEqual(EMBED_DEFAULTS);
  });

  it("reads the URL hash", () => {
    expect(embedConfigFromHash("#" + encodeURIComponent(JSON.stringify({ symbol: "NYSE:IBM" }))).symbol).toBe("NYSE:IBM");
    expect(embedConfigFromHash("#%7Bbroken")).toEqual(EMBED_DEFAULTS);
    expect(isEmbedView("?view=embed")).toBe(true);
    expect(isEmbedView("?view=screener")).toBe(false);
  });
});

describe("embed start", () => {
  it("seeds the stored settings the app starts with", () => {
    expect(embedSeedItems(parseEmbedConfig({ theme: "light", locale: "fr", timezone: "Europe/Paris", drawingToolbar: true }))).toEqual({
      "ot:theme": "light",
      "ot:language": "fr",
      "ot:timezone": JSON.stringify({ label: "(UTC+2) Paris", iana: "Europe/Paris" }),
      "ot:drawing-panel-visible": "1",
    });
    expect(embedSeedItems(parseEmbedConfig({ timezone: "exchange" }))).toEqual({ "ot:drawing-panel-visible": "0" });
  });

  it("keeps the storage in memory", () => {
    const s = new MemoryStorage();
    s.setItem("a", "1");
    s.setItem("b", "2");
    s.removeItem("a");
    expect([s.length, s.key(0), s.getItem("b"), s.getItem("a")]).toEqual([1, "b", "2", null]);
  });

  it("opens on the chart the settings describe", () => {
    const tab = embedSeedTab(
      parseEmbedConfig({ symbol: "NYSE:IBM", chartType: "line", extendedHours: true, hideVolume: true, studies: [{ id: "rsi", inputs: { length: 7 } }], compare: ["NASDAQ:MSFT", "NYSE:IBM"] }),
    );
    expect(tab.panes).toHaveLength(1);
    const p = tab.panes[0];
    expect([p.symbol, p.interval, p.chartType, p.session, p.indicators]).toEqual(["NYSE:IBM", "1D", "line", "ETH", ["rsi"]]);
    expect(p.indicatorSettings).toEqual({ rsi: { inputs: { length: 7 } } });
    expect(p.compare?.map((e) => [e.symbol, e.placement])).toEqual([["NASDAQ:MSFT", "percent"]]);
    expect(embedSeedTab(parseEmbedConfig({})).panes[0].indicators).toEqual(["volume"]);
  });

  it("takes the range's interval", () => {
    expect(embedInterval(parseEmbedConfig({ range: "5D", interval: "1W" }))).toBe("5");
    expect(embedInterval(parseEmbedConfig({ interval: "60" }))).toBe("60");
  });
});
