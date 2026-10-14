import { describe, expect, it, vi } from "vitest";

vi.mock("../../../bindings", () => ({ commands: {} }));
vi.mock("../../../data/kv", () => ({ getItem: () => null, setItem: () => {}, onExternalChange: () => () => {} }));

import { LineStyle, type Time } from "lightweight-charts";
import type { OHLC } from "lightweight-charts-drawing/core/coords";
import { DEFAULT_SERIES_STYLES, type SeriesStyles } from "../../header/chart-settings";
import type { ChartTokens } from "../chart-tokens";
import {
  CHART_TYPE_ICON,
  CHART_TYPE_IDS,
  heikinAshiLast,
  isTransformType,
  legendShowsSingleValue,
  libLineStyle,
  setDataForType,
  type AnySeries,
  type ChartTypeId,
} from "../chart-types";

const bar = (i: number, open: number, high: number, low: number, close: number): OHLC => ({ time: (1000 + i * 60) as Time, open, high, low, close });
// Up, down, up-but-below-the-previous-close.
const raw = [bar(0, 10, 12, 9, 11), bar(1, 11, 11.5, 9.5, 10), bar(2, 9, 10.5, 8.5, 9.8)];

/** A fake series that records setData / applyOptions. */
function fakeSeries() {
  const calls = { data: [] as unknown[], options: [] as unknown[] };
  const series = {
    setData: (d: unknown[]) => void (calls.data = d),
    applyOptions: (o: unknown) => void calls.options.push(o),
  } as unknown as AnySeries;
  return { series, calls };
}
const tokens = (patch: (s: SeriesStyles) => SeriesStyles = (s) => s) => ({ styles: patch(structuredClone(DEFAULT_SERIES_STYLES)) }) as unknown as ChartTokens;

describe("chart type tables", () => {
  it("every type has an icon", () => {
    for (const id of CHART_TYPE_IDS) expect(CHART_TYPE_ICON[id], id).toMatch(/^menu-candles-/);
    expect(CHART_TYPE_IDS.size).toBe(21);
  });

  it("single-value legend for the line / area / column family", () => {
    const single = [...CHART_TYPE_IDS].filter(legendShowsSingleValue);
    expect(single.sort()).toEqual(["area", "baseline", "column", "hlcArea", "line", "lineWithMarkers", "stepline"]);
  });

  it("price-based transforms are rebuilt from the whole history", () => {
    const t = [...CHART_TYPE_IDS].filter(isTransformType);
    expect(t.sort()).toEqual(["kagi", "pb", "pnf", "range", "renko"]);
    expect(isTransformType("ha" as ChartTypeId)).toBe(false);
  });

  it("line style enum", () => {
    expect(libLineStyle(0)).toBe(LineStyle.Solid);
    expect(libLineStyle(1)).toBe(LineStyle.Dashed);
    expect(libLineStyle(2)).toBe(LineStyle.Dotted);
    expect(libLineStyle(7)).toBe(LineStyle.Solid);
  });
});

describe("setDataForType", () => {
  it("candles: plain OHLC, or coloured by the previous close", () => {
    const plain = fakeSeries();
    setDataForType(plain.series, "candle", raw, tokens());
    expect(plain.calls.data).toEqual(raw.map((r) => ({ time: r.time, open: r.open, high: r.high, low: r.low, close: r.close })));

    const prev = fakeSeries();
    const t = tokens((s) => ({ ...s, candle: { ...s.candle, prevClose: true } }));
    setDataForType(prev.series, "candle", raw, t);
    const c = DEFAULT_SERIES_STYLES.candle;
    const colors = (prev.calls.data as { color: string; borderColor: string }[]).map((d) => d.color);
    // Bar 0: close vs its own open (up); bar 1: 10 < 11 (down); bar 2: 9.8 < 10 (down, although close > open).
    expect(colors).toEqual([c.bodyUp, c.bodyDown, c.bodyDown]);
  });

  it("hollow candles: colour from the previous close, hollow when close > open", () => {
    const f = fakeSeries();
    setDataForType(f.series, "hollowCandle", raw, tokens());
    const h = DEFAULT_SERIES_STYLES.hollowCandle;
    const d = f.calls.data as { color: string; borderColor: string }[];
    expect(d[0].color).toBe("rgba(0,0,0,0)"); // up bar: hollow
    expect(d[0].borderColor).toBe(h.borderUp);
    expect(d[1].color).toBe(h.bodyDown); // filled down bar
    expect(d[2].color).toBe("rgba(0,0,0,0)"); // close > open: hollow…
    expect(d[2].borderColor).toBe(h.borderDown); // …in the down colour (below the previous close)
  });

  it("line family: one value per bar from the price source", () => {
    const f = fakeSeries();
    setDataForType(f.series, "area", raw, tokens((s) => ({ ...s, area: { ...s.area, source: "hl2" } })));
    expect(f.calls.data).toEqual(raw.map((r) => ({ time: r.time, value: (r.high + r.low) / 2 })));
  });

  it("columns: colour by close vs open, last colour applied to the series", () => {
    const f = fakeSeries();
    setDataForType(f.series, "column", raw, tokens((s) => ({ ...s, column: { ...s.column, prevClose: false } })));
    const col = DEFAULT_SERIES_STYLES.column;
    expect((f.calls.data as { fill: string }[]).map((d) => d.fill)).toEqual([col.up, col.down, col.up]);
    expect(f.calls.options).toEqual([{ color: col.up }]);
  });

  it("Heikin Ashi series and its last value", () => {
    const f = fakeSeries();
    setDataForType(f.series, "ha", raw, tokens((s) => ({ ...s, ha: { ...s.ha, prevClose: false } })));
    expect((f.calls.data as { close: number }[])[0].close).toBe(10.5);
    expect(heikinAshiLast(raw)!.close).toBeCloseTo((9 + 10.5 + 8.5 + 9.8) / 4, 12);
    expect(heikinAshiLast([])).toBeNull();
  });

  it("line break bricks get the projection colours on the forming bar", () => {
    const f = fakeSeries();
    const rising = [bar(0, 10, 10, 10, 10), bar(1, 10, 11, 10, 11), bar(2, 11, 12, 11, 12)];
    setDataForType(f.series, "pb", rising, tokens(), { lastForming: true });
    const pb = DEFAULT_SERIES_STYLES.pb;
    expect((f.calls.data as { color: string }[]).map((d) => d.color)).toEqual([pb.up.fill, pb.projUp.fill]);
  });
});
