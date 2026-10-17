import { describe, expect, it } from "vitest";
import { indicatorRegistry } from "lightweight-charts-indicators";
import { applyStyleOverrides, outputValueRows, sameColor, styleItems, styleKey, type StyleEntry } from "../style-outputs";

const entry = (id: string) => indicatorRegistry.find((e) => e.id === id)! as unknown as StyleEntry & { calculate: (...a: unknown[]) => any; defaultInputs: Record<string, unknown> };
const bars = Array.from({ length: 400 }, (_, i) => {
  const c = 100 + Math.sin(i / 6) * 8 + Math.sin(i / 2.3) * 2;
  // a doji every 25 bars (open = close)
  return { time: 1577836800 + i * 86400, open: i % 25 === 0 ? c : c - 0.5, high: c + 1.5, low: c - 1.5, close: c, volume: 1e6 + (i % 7) * 1e5 };
});

describe("styleItems", () => {
  it("lists the outputs in the reference order and leaves the not editable ones out", () => {
    expect(styleItems(entry("williams-fractals")).map((i) => `${i.kind}:${i.key}`)).toEqual(["shape:shape:downFractal", "shape:shape:upFractal"]);
    const rsi = styleItems(entry("rsi")).map((i) => (i.kind === "plot" ? i.def.title : `${i.kind}:${"decl" in i ? (i.decl as { title?: string }).title : ""}`));
    expect(rsi).toEqual([
      "RSI",
      "RSI-based MA",
      "hline:RSI Upper Band",
      "hline:RSI Middle Band",
      "hline:RSI Lower Band",
      "fill:RSI Background Fill",
      "fill:Overbought Gradient Fill",
      "fill:Oversold Gradient Fill",
    ]);
    expect(styleItems(entry("doji")).map((i) => i.key)).toEqual(["colors:bgcolor0", "drawing:label"]);
  });

  it("puts a background colour after the outputs declared before it", () => {
    const e: StyleEntry = {
      plotConfig: [{ id: "plot0", title: "A", color: "#000" }, { id: "plot1", title: "B", color: "#000" }],
      outputs: [{ kind: "plot", id: "plot0" }, { kind: "plot", id: "plot1" }],
      barColorConfig: [{ id: "bgcolor0", kind: "bgcolor", outputIndex: 1 }],
    };
    expect(styleItems(e).map((i) => i.key)).toEqual(["plot0", "colors:bgcolor0", "plot1"]);
  });

  it("untitled fills take the reference names", () => {
    const e: StyleEntry = {
      plotConfig: [{ id: "plot0", title: "A", color: "#000" }, { id: "plot1", title: "B", color: "#000" }],
      hlineConfig: [{ id: "hline0", price: 1 }, { id: "hline1", price: 0 }],
      fillConfig: [{ id: "fill0", plot1: "plot0", plot2: "plot1" }, { id: "fill1", plot1: "hline0", plot2: "hline1" }],
    };
    const titles = styleItems(e).flatMap((i) => (i.kind === "fill" ? [i.decl.title] : []));
    expect(titles).toEqual(["Plots Background", "Hlines Background"]);
  });

  it("output value rows follow what the study outputs", () => {
    expect(outputValueRows(entry("williams-fractals") as never)).toEqual({ precision: true, values: true, inputs: true });
    expect(outputValueRows(entry("doji") as never)).toMatchObject({ precision: true, values: false });
    expect(outputValueRows(entry("auto-fib-retracement") as never)).toMatchObject({ precision: false, values: false });
  });
});

describe("applyStyleOverrides", () => {
  it("shapes: hidden, colour, shape and location", () => {
    const e = entry("williams-fractals");
    const r = e.calculate(bars, { ...e.defaultInputs });
    const styles = {
      [styleKey("shape", "upFractal")]: { visible: false },
      [styleKey("shape", "downFractal")]: { color: "#112233", shape: "circle", location: "top" },
    };
    const out = applyStyleOverrides(e, r, styles, bars).result;
    expect(out.markers.some((m: { id: string }) => m.id === "upFractal")).toBe(false);
    const down = out.markers.filter((m: { id: string }) => m.id === "downFractal");
    expect(down.length).toBeGreaterThan(0);
    expect(down.every((m: { color: string; shape: string; position: string }) => m.color === "#112233" && m.shape === "circle" && m.position === "top")).toBe(true);
  });

  it("a shape moved to Absolute is drawn on its series value", () => {
    const e = entry("williams-fractals");
    const r = e.calculate(bars, { ...e.defaultInputs });
    const out = applyStyleOverrides(e, r, { [styleKey("shape", "upFractal")]: { location: "absolute" } }, bars).result;
    const up = out.markers.filter((m: { id: string }) => m.id === "upFractal");
    expect(up.length).toBeGreaterThan(0);
    for (const m of up) {
      expect(m.position).toBe("atPriceMiddle");
      expect(Number.isFinite(m.price)).toBe(true);
    }
  });

  it("background colours: palette colour replaced, hidden dropped; candlestick labels follow the labels row", () => {
    const e = entry("doji");
    const r = e.calculate(bars, { ...e.defaultInputs });
    expect(r.bgColors.length).toBeGreaterThan(0);
    const recolored = applyStyleOverrides(e, r, { [styleKey("colors", "bgcolor0")]: { palette: ["#ff0000"] } }, bars).result;
    expect(recolored.bgColors.every((b: { color: string }) => b.color === "#ff0000")).toBe(true);
    const hidden = applyStyleOverrides(e, r, { [styleKey("colors", "bgcolor0")]: { visible: false }, [styleKey("drawing", "label")]: { visible: false } }, bars).result;
    expect(hidden.bgColors).toEqual([]);
    expect(hidden.markers).toEqual([]);
  });

  it("hlines and fills between hlines through the entry; fills between plots through the result", () => {
    const e = entry("rsi");
    const r = e.calculate(bars, { ...e.defaultInputs });
    const styles = {
      [styleKey("hline", "hline_upper")]: { color: "#00ff00", price: 80, lineStyle: "dotted" as const, lineWidth: 2 },
      [styleKey("hline", "hline_mid")]: { visible: false },
      [styleKey("fill", "fill_band")]: { color: "#0000ff" },
      [styleKey("fill", "fill_1")]: { visible: false },
      [styleKey("fill", "fill_2")]: { topColor: "#123456" },
    };
    const out = applyStyleOverrides(e, r, styles, bars);
    expect(out.hlineConfig!.find((h) => h.id === "hline_upper")).toMatchObject({ color: "#00ff00", price: 80, linestyle: "dotted", linewidth: 2 });
    expect(out.hlineConfig!.find((h) => h.id === "hline_mid")!.display).toBe("none");
    expect(out.fillConfig!.find((f) => f.id === "fill_band")!.color).toBe("#0000ff");
    expect(out.result.fills.map((f: { id: string }) => f.id)).toEqual(["fill_2"]);
    const top = out.result.fills[0].gradient.topColor.filter((c: string | null) => c != null);
    expect(top.length).toBeGreaterThan(0);
    expect(top.every((c: string) => c === "#123456")).toBe(true);
  });

  it("a fill between plots of one colour takes the override without its transparency setting", () => {
    const e = entry("bb");
    const r = e.calculate(bars, { ...e.defaultInputs });
    const out = applyStyleOverrides(e, r, { [styleKey("fill", "fill_0")]: { color: "rgba(255, 0, 0, 0.3)" } }, bars).result;
    expect(out.fills[0].options).toMatchObject({ color: "rgba(255, 0, 0, 0.3)", transp: undefined });
  });

  it("candles: palette colours replaced per part", () => {
    const e = entry("bb-bars");
    const r = e.calculate(bars, { ...e.defaultInputs });
    const out = applyStyleOverrides(e, r, { [styleKey("candle", "body")]: { palette: ["#000001", "#000002"] }, [styleKey("candle", "wicks")]: { visible: false } }, bars).result;
    expect(out.plotCandles.wicks).toBeUndefined();
    const colors = new Set(out.plotCandles.body.map((c: { color: string }) => c.color));
    expect([...colors].every((c) => c === "#000001" || c === "#000002")).toBe(true);
  });

  it("candles with the default colours take the Body / Wick / Border overrides", () => {
    const e = { plotConfig: [], plotCandleConfig: [{ id: "plotcandle0", kind: "candle", title: "PlotCandle", color: "#2962FF", wickColor: "#737375", borderColor: "#000000" }] } as StyleEntry;
    const candle = { time: 1, open: 1, high: 2, low: 0, close: 1.5, color: "#2962FF", wickColor: "#737375", borderColor: "#000000" };
    const out = applyStyleOverrides(e, { plots: {}, plotCandles: { plotcandle0: [candle] } }, { [styleKey("candle", "plotcandle0")]: { wickColor: "#FF0000", borderColor: "#00FF00" } }, bars).result;
    expect(out.plotCandles.plotcandle0[0]).toMatchObject({ color: "#2962FF", wickColor: "#FF0000", borderColor: "#00FF00" });
  });

  it("drawings of a hidden kind are not drawn", () => {
    const e = { plotConfig: [], drawingKinds: ["label", "line"] } as StyleEntry;
    const out = applyStyleOverrides(e, { plots: {}, labels: [{ time: 1 }], lines: [{ time: 1 }] }, { [styleKey("drawing", "line")]: { visible: false } }, bars).result;
    expect(out.labels).toHaveLength(1);
    expect(out.lines).toEqual([]);
  });

  it("colours compare by value", () => {
    expect(sameColor("#2962FF1A", "rgba(41, 98, 255, 0.1)")).toBe(true);
    expect(sameColor("rgba(120, 123, 134, 0.09999999999999998)", "rgba(120,123,134,0.1)")).toBe(true);
    expect(sameColor("#089981", "#F23645")).toBe(false);
  });
});
