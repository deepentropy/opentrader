import { describe, expect, it } from "vitest";
import { DEFAULT_TAPE, MAX_TAPE, parseEmbedConfig } from "../config";
import { embedColorProperties } from "../boot";
import { RANGE_BARS } from "../widgets/MiniChart";

describe("widget settings", () => {
  it("reads the widget and its own settings", () => {
    const c = parseEmbedConfig({ widget: "ticker-tape", symbols: "NASDAQ:AAPL, x, NYSE:IBM", direction: "vertical", hideLogos: "", movers: true });
    expect([c.widget, c.symbols, c.direction, c.hideLogos, c.movers]).toEqual(["ticker-tape", ["NASDAQ:AAPL", "NYSE:IBM"], "vertical", true, true]);
    expect(parseEmbedConfig({ widget: "nope" }).widget).toBe("chart");
    expect(parseEmbedConfig({ symbols: "bad" }).symbols).toEqual(DEFAULT_TAPE);
    const many = Array.from({ length: 40 }, (_, i) => `NYSE:T${i}`);
    expect(parseEmbedConfig({ symbols: many }).symbols).toHaveLength(MAX_TAPE);
  });

  it("keeps only colours and fonts a page can write", () => {
    const c = parseEmbedConfig({
      colors: { background: "#101820", text: "rgb(240, 240, 240)", up: "teal", down: "url(x)", accent: "hsl(220 90% 56%)", font: "Inter, sans-serif", border: "1px solid red" },
    });
    expect(c.colors).toEqual({ background: "#101820", text: "rgb(240, 240, 240)", up: "teal", accent: "hsl(220 90% 56%)", font: "Inter, sans-serif" });
    expect(parseEmbedConfig({ colors: { font: "a;}body{x" } }).colors).toEqual({});
  });

  it("sets the app's colour properties from the page's colours", () => {
    const p = embedColorProperties({ background: "#000", up: "#0f0", font: "Inter" });
    expect(p["--ot-chart-bg"]).toBe("#000");
    expect(p["--color-bg-primary"]).toBe("#000");
    expect(p["--ot-chart-up"]).toBe("#0f0");
    expect(p["--font-family-base"]).toBe("Inter");
    expect(p["--ot-chart-down"]).toBeUndefined();
  });
});

describe("mini chart ranges", () => {
  const DAY = 86_400;
  it("keeps the last session for 1D and the last five days for 5D", () => {
    // Two sessions a day apart, three bars each.
    const t = [0, 1800, 3600, DAY, DAY + 1800, DAY + 3600];
    expect(RANGE_BARS["1D"].keep(t)).toBe(DAY + 3600 - DAY / 2);
    const days = Array.from({ length: 8 }, (_, i) => i * DAY + 100);
    expect(RANGE_BARS["5D"].keep(days)).toBe(3 * DAY + 100);
    expect(RANGE_BARS.All.keep(days)).toBe(-Infinity);
  });
});
