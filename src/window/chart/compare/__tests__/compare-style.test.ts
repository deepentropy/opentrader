import { describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => new Map<string, string>());
vi.mock("../../../../data/kv", () => ({
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  onExternalChange: () => () => {},
}));

import { DEFAULT_SERIES_STYLES } from "../../../header/chart-settings";
import {
  COMPARE_COLORS,
  COMPARE_STYLES,
  chartTypeOf,
  cloneCompareStyle,
  compareColor,
  compareSeriesStyles,
  compareSource,
  defaultCompareStyle,
  newCompareStyle,
  reviveCompareStyle,
  saveCompareDefault,
} from "../compare-style";

const RED = "#ff0000";

describe("compare styles", () => {
  it("style list and add-order colours", () => {
    expect(COMPARE_STYLES).toHaveLength(12);
    expect(COMPARE_COLORS).toHaveLength(10);
    expect(new Set(COMPARE_COLORS).size).toBe(10);
  });

  it("every style draws with a chart type; HLC bars are bars", () => {
    expect(chartTypeOf("hlcBars")).toBe("bar");
    for (const s of COMPARE_STYLES) if (s.id !== "hlcBars") expect(chartTypeOf(s.id)).toBe(s.id);
  });
});

describe("defaultCompareStyle", () => {
  it("a line in the symbol's colour, on the close", () => {
    const s = defaultCompareStyle(RED);
    expect(s.style).toBe("line");
    expect(s.priceLine).toBe(false);
    expect(s.minTick).toBe("Default");
    expect(compareColor(s)).toBe(RED);
    expect(compareSource(s)).toBe("close");
    expect(compareSeriesStyles(s).line).toMatchObject({ source: "close", type: "Solid", color: RED });
  });

  it("only the drawn style's entry differs from the main series styles", () => {
    const st = compareSeriesStyles(defaultCompareStyle(RED));
    expect(st.candle).toEqual(DEFAULT_SERIES_STYLES.candle);
    expect(st.area).toEqual(DEFAULT_SERIES_STYLES.area);
  });
});

describe("compareSeriesStyles per style", () => {
  it("HLC bars: one colour, open tick hidden", () => {
    const s = { ...defaultCompareStyle(RED), style: "hlcBars" as const };
    const bar = compareSeriesStyles(s).bar;
    expect(bar.hlc).toBe(true);
    expect(bar.prevClose).toBe(false);
    expect(bar.up).toBe(bar.down);
    expect(compareColor(s)).toBe(bar.up);
  });

  it("hollow candles never colour on the previous close", () => {
    const s = { ...defaultCompareStyle(RED), style: "hollowCandle" as const };
    expect(compareSeriesStyles(s).hollowCandle.prevClose).toBe(false);
  });

  it("baseline level defaults to 50 when the field is not a number", () => {
    const s = { ...defaultCompareStyle(RED), style: "baseline" as const };
    expect(compareSeriesStyles(s).baseline.level).toBe(50);
  });
});

describe("reviveCompareStyle", () => {
  it("non-objects give the factory style", () => {
    expect(reviveCompareStyle(null, RED)).toEqual(defaultCompareStyle(RED));
    expect(reviveCompareStyle("x", RED)).toEqual(defaultCompareStyle(RED));
  });

  it("drops unknown styles, min ticks and values of another control kind", () => {
    const s = reviveCompareStyle(
      { style: "renko", minTick: "1/7", priceLine: "yes", rows: { "line:Line": { controls: [{ kind: "select", value: "x" }] }, "bogus:row": { checked: true } } },
      RED,
    );
    const def = defaultCompareStyle(RED);
    expect(s.style).toBe("line");
    expect(s.minTick).toBe("Default");
    expect(s.priceLine).toBe(false);
    expect(s.rows).toEqual(def.rows);
  });

  it("keeps valid stored values", () => {
    const def = defaultCompareStyle(RED);
    const stored = cloneCompareStyle(def);
    stored.style = "area";
    stored.minTick = "1/32";
    stored.priceLine = true;
    stored.visibility.days = { on: false, from: 2, to: 5 };
    const back = reviveCompareStyle(JSON.parse(JSON.stringify(stored)), RED);
    expect(back.style).toBe("area");
    expect(back.minTick).toBe("1/32");
    expect(back.priceLine).toBe(true);
    expect(back.visibility.days).toEqual({ on: false, from: 2, to: 5 });
    expect(back.visibility.minutes).toEqual(def.visibility.minutes);
  });

  it("partial visibility units fall back field by field", () => {
    const def = defaultCompareStyle(RED);
    const back = reviveCompareStyle({ visibility: { hours: { on: false }, ticks: "no" } }, RED);
    expect(back.visibility.hours).toEqual({ ...def.visibility.hours, on: false });
    expect(back.visibility.ticks).toBe(def.visibility.ticks);
  });
});

describe("cloneCompareStyle / saved default", () => {
  it("clone is independent", () => {
    const a = defaultCompareStyle(RED);
    const b = cloneCompareStyle(a);
    b.visibility.days.on = !a.visibility.days.on;
    expect(a.visibility.days.on).not.toBe(b.visibility.days.on);
  });

  it("a new compared symbol takes the saved default with its own add-order colour", () => {
    expect(newCompareStyle(RED)).toEqual(defaultCompareStyle(RED));
    const saved = { ...defaultCompareStyle("#00ff00"), style: "area" as const, priceLine: true };
    saveCompareDefault(saved);
    const next = newCompareStyle(COMPARE_COLORS[1]);
    expect(next.style).toBe("area");
    expect(next.priceLine).toBe(true);
    const line = next.rows["line:Line"].controls[0];
    expect(line.kind === "color" ? line.color : null).toBe(COMPARE_COLORS[1]);
  });
});
