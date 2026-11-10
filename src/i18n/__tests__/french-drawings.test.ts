/*
 * French (#291): the numbers the drawings write (rulers, positions, prices, coefficients, volumes) and the
 * indexed-to-100 scale; English and Chinese as they were.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { DrawingLabel } from "lightweight-charts-drawing/core/labels";
import { setNumberFormat } from "lightweight-charts-drawing/core/numbers";
import { positionLegText, positionMiddleText } from "lightweight-charts-drawing/core/kinds/position";
import { fibCoeffText } from "lightweight-charts-drawing/core/kinds/fib-labels";
import { priceLabelText } from "lightweight-charts-drawing/core/kinds/text-tools";
import { fmtCoeff } from "lightweight-charts-drawing/core/scene/fib";
import { signedFixed, tvTimeSpan, tvVolume } from "lightweight-charts-drawing/core/scene/text";
import { defaultStyleFor } from "lightweight-charts-drawing/core/specs";
import fr from "../fr.json";
import zhHans from "../zh-Hans.json";
import { drawingLabelFormatter, drawingNumberFormat } from "../drawing-labels";
import { languageEntry } from "../languages";
import { setDictionary, type Dictionary } from "../translator";
import { localizeFormat } from "../../window/chart/price-format";

const NNBSP = " ";
const MINUS = "−";

const as = (id: string, d: Dictionary = {}) => {
  const l = languageEntry(id)!;
  setDictionary(d, [], l.pluralLocale, l.formats);
  // As the chart does when it makes its coords.
  setNumberFormat(drawingNumberFormat());
};
afterEach(() => {
  setDictionary({});
  setNumberFormat(undefined);
});

/** The drawings' number texts. */
function drawn() {
  const pos = defaultStyleFor("long-position");
  return {
    target: positionLegText(pos, "tp", 1500, 1250, 0.01, 2, 25193.55, 0, null),
    stop: positionLegText({ ...pos, compactStats: true }, "sl", -15.5, 1250, 0.01, 2, 750, 0, null),
    middle: positionMiddleText(pos, -40.5, false, 1234, 1.94, 2, null),
    change: `${signedFixed(-266.25, 2)} (${signedFixed(-17.74, 2)}%)`,
    span: [tvTimeSpan(1500 * 86400 + 3600), tvTimeSpan(-20 * 86400)],
    volume: [tvVolume(103_470_000), tvVolume(1_960_000_000), tvVolume(830)],
    price: priceLabelText(1234.5, null),
    coeff: [fibCoeffText(0.618, false), fibCoeffText(0.236, true), fmtCoeff(1.618)],
  };
}

const ENGLISH = {
  target: "Target: 1,500.00 (120.000%) 150,000, Amount: 25193.55",
  stop: `${MINUS}15.50 (-1.240%) ${MINUS}1,550 750`,
  middle: `Open PnL: ${MINUS}40.50, Qty: 1234\nRisk/reward ratio: 1.94`,
  change: `${MINUS}266.25 (${MINUS}17.74%)`,
  span: ["1,500d 1h", "-20d"],
  volume: [`103.47${NNBSP}M`, `1.96${NNBSP}B`, "830"],
  price: "1234.50",
  coeff: ["0.618", "23.60%", "1.618"],
};

describe("drawing numbers (#291)", () => {
  it("English and Chinese: the library's own text", () => {
    as("en");
    expect(drawingNumberFormat()).toBeUndefined();
    expect(drawn()).toEqual(ENGLISH);
    as("zh-Hans", zhHans as Dictionary);
    expect(drawingNumberFormat()).toBeUndefined();
    expect(drawn()).toEqual(ENGLISH);
  });

  it("French: narrow no-break spaces, decimal comma, minus sign, the unit after a narrow space", () => {
    as("fr", fr as Dictionary);
    expect(drawn()).toEqual({
      target: `Target: 1${NNBSP}500,00 (120,000%) 150${NNBSP}000, Amount: 25${NNBSP}193,55`,
      stop: `${MINUS}15,50 (${MINUS}1,240%) ${MINUS}1${NNBSP}550 750`,
      middle: `Open PnL: ${MINUS}40,50, Qty: 1${NNBSP}234\nRisk/reward ratio: 1,94`,
      change: `${MINUS}266,25 (${MINUS}17,74%)`,
      span: [`1${NNBSP}500d 1h`, `${MINUS}20d`],
      volume: [`103,47${NNBSP}M`, `1,96${NNBSP}B`, "830"],
      price: `1${NNBSP}234,50`,
      coeff: ["0,618", "23,60%", "1,618"],
    });
  });

  it("French labels keep the numbers the library wrote", () => {
    as("fr", fr as Dictionary);
    const f = drawingLabelFormatter()!;
    const ctx = { kind: "trend-line", drawingId: "d1" };
    const label = (l: { id: DrawingLabel["id"]; text: string; [field: string]: unknown }) => f({ ...l, ...ctx } as DrawingLabel);
    expect(label({ id: "bars-range", text: `1${NNBSP}500 bars`, bars: 1500 })).toBe(`1${NNBSP}500 barres`);
    // The same text: the label is left as it is.
    expect(label({ id: "distance", text: `distance: 15${NNBSP}005 px`, distancePx: 15005 })).toBeUndefined();
    expect(label({ id: "forecast", text: `${MINUS}19,50 (${MINUS}1,56%) in 1${NNBSP}500d 1h`, change: -19.5, percent: -1.56, seconds: 0, digits: 2 }))
      .toBe(`${MINUS}19,50 (${MINUS}1,56%) en 1${NNBSP}500d 1h`);
  });

  it("Chinese labels as before", () => {
    as("zh-Hans", zhHans as Dictionary);
    const f = drawingLabelFormatter()!;
    const ctx = { kind: "trend-line", drawingId: "d1" };
    expect(f({ id: "bars-range", text: "1500 bars", bars: 1500, ...ctx })).toBe("1500 根K线");
    expect(f({ id: "distance", text: "distance: 25 px", distancePx: 25, ...ctx })).toBe("距离：25 像素");
    expect(f({ id: "time-span", text: "1,500d 1h", seconds: 0, ...ctx })).toBe("1,500天 1小时");
  });
});

describe("the indexed-to-100 scale (#291)", () => {
  // The chart library's price formatter: English marks, minus U+2212.
  class LibraryFormatter {
    format(price: number): string {
      return `${price < 0 ? MINUS : ""}${Math.abs(price).toFixed(2)}`;
    }
  }
  const proto = LibraryFormatter.prototype;
  expect(localizeFormat(proto)).toBe(true);

  it("in the language's marks", () => {
    as("fr");
    expect(new LibraryFormatter().format(103.25)).toBe("103,25");
    expect(new LibraryFormatter().format(1234.5)).toBe("1234,50");
  });

  it("English and Chinese as the library writes them", () => {
    as("en");
    expect(new LibraryFormatter().format(103.25)).toBe("103.25");
    as("zh-Hans");
    expect(new LibraryFormatter().format(-3.5)).toBe(`${MINUS}3.50`);
  });

  it("only a prototype with its own format", () => {
    expect(localizeFormat(null)).toBe(false);
    expect(localizeFormat(Object.create(proto))).toBe(false);
  });
});
