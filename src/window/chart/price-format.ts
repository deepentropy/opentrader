/*
 * Chart price text, as the reference app's price formatter: the Symbol →
 * Precision choice sets the decimals ("Default" = the symbol's tick grid, see
 * SymbolSessions.formatPrice), the integer part is grouped by thousands with
 * "," and the decimal sign is "." (the English number format), negatives use
 * the "−" sign. One formatter per chart serves the price axis, the crosshair
 * and last-price labels (series priceFormat) and the legend values. A language
 * writing numbers with other marks gets them on the finished text ("1 234,5",
 * i18n/format localNumber).
 */
import { LineSeries, type IChartApi } from "lightweight-charts";
import type { SymbolSessions } from "../../data/session";
import { volumeFormat } from "../../data/volume-format";
import { activeFormats } from "../../i18n/translator";
import { localNumber } from "../../i18n/format";

const MINUS = "−";

/** "1234567.5" → "1,234,567.5" (sign and decimals untouched). */
export function groupThousands(text: string): string {
  const m = /^(-?)(\d+)(.*)$/.exec(text);
  if (!m) return text;
  const [, sign, int, rest] = m;
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return (sign ? MINUS : "") + grouped + rest;
}

export type ChartPriceFormat = {
  format: (price: number) => string;
  /** Smallest price step of the series (price scale rounding). */
  minMove: number;
};

/** The chart price format for a Precision choice. `grid` is the symbol's
 *  tick grid (null until its session resolves: 2 decimals). The fractional
 *  choices "1/2" … "1/320" use the fractional format. */
export function chartPriceFormat(precision: string | undefined, grid: SymbolSessions | null, abbreviated = false): ChartPriceFormat | null {
  const f = priceFormatOf(precision, grid, abbreviated);
  // The marks of the interface language ("1 234,5"), on the scales, the labels and the legend alike.
  return f && { format: remembered((v) => localNumber(f.format(v))), minMove: f.minMove };
}

/** The chart's options for a language writing numbers with other marks: the percentage scale's labels ("+5,81%");
 *  none in English (the library's own). */
export function chartNumberOptions(): { percentageFormatter?: (v: number) => string } {
  if (!activeFormats().numberMarks) return {};
  return { percentageFormatter: remembered((v) => localNumber(`${v < 0 ? MINUS : ""}${Math.abs(v).toFixed(2)}%`)) };
}

let libraryNumbersLocal = false;

/**
 * The chart library's own price formatter in the marks of the interface language: the indexed-to-100 scale writes its
 * values with it ("103.25") and takes no formatter option. In a language writing numbers with other marks its
 * `format` is wrapped once for the page ("103,25"); nothing changes in English. Its class is reached through the
 * default price format of a hidden series, removed at once.
 */
export function localizeLibraryNumbers(chart: IChartApi): void {
  if (libraryNumbersLocal || !activeFormats().numberMarks) return;
  const probe = chart.addSeries(LineSeries, { visible: false, priceFormat: { type: "price", precision: 2, minMove: 0.01 } });
  const formatter: object = probe.priceFormatter();
  chart.removeSeries(probe);
  libraryNumbersLocal = localizeFormat(Object.getPrototypeOf(formatter));
}

/** `proto.format`'s English text in the interface language's marks; false when it has no own `format`. */
export function localizeFormat(proto: { format?: (price: number) => string } | null): boolean {
  const format = proto && Object.prototype.hasOwnProperty.call(proto, "format") ? proto.format : undefined;
  if (!proto || typeof format !== "function") return false;
  proto.format = function (this: unknown, price: number) {
    return localNumber(format.call(this, price));
  };
  return true;
}

/**
 * A study's own value format on its scale ("price", "percent" or "volume" with its decimals) in a language writing
 * numbers with other marks than English: the chart library writes the English ones itself ("1234.50", "1.5K"), so
 * the study's series take this custom format instead ("1 234,50", "1,5 K"). Null in English.
 */
export function studyScaleFormat(type: "price" | "percent" | "volume", precision: number): StudyScaleFormat | null {
  if (!activeFormats().numberMarks) return null;
  // One per format: the series' options are compared before they are applied again.
  const key = `${type}|${precision}`;
  let f = studyScaleFormats.get(key);
  if (!f) studyScaleFormats.set(key, (f = studyScaleFormatOf(type, precision)));
  return f;
}

type StudyScaleFormat = { type: "custom"; formatter: (v: number) => string; minMove: number };
const studyScaleFormats = new Map<string, StudyScaleFormat>();

function studyScaleFormatOf(type: "price" | "percent" | "volume", precision: number): StudyScaleFormat {
  const text =
    type === "volume"
      ? (v: number) => volumeFormat(v, precision)
      : type === "percent"
        ? (v: number) => `${groupThousands(v.toFixed(precision))}%`
        : (v: number) => groupThousands(v.toFixed(precision));
  return { type: "custom", formatter: remembered((v) => localNumber(text(v))), minMove: 1 / 10 ** precision };
}

/** Texts kept per formatter: every paint formats the same prices again (each plot's price label, the axis and the
 *  legend), dozens of times per live tick with a many-level study (#259). */
const REMEMBERED = 4096;
function remembered(format: (v: number) => string): (v: number) => string {
  const texts = new Map<number, string>();
  return (v) => {
    let t = texts.get(v);
    if (t === undefined) {
      if (texts.size >= REMEMBERED) texts.clear();
      texts.set(v, (t = format(v)));
    }
    return t;
  };
}

function priceFormatOf(precision: string | undefined, grid: SymbolSessions | null, abbreviated: boolean): ChartPriceFormat | null {
  const p = precision || "Default";
  if (p === "Default") {
    const base = grid ? { format: (v: number) => groupThousands(grid.formatPrice(v)), minMove: grid.mintick } : fixed(2);
    return abbreviated ? { format: (v) => abbreviatedPrice(v, base.format), minMove: base.minMove } : base;
  }
  if (p === "Integer") return fixed(0);
  const m = /^(\d+)\s+decimal/.exec(p);
  if (m) return fixed(+m[1]);
  const f = /^(\d+)\/(\d+)$/.exec(p);
  if (f && +f[1] > 0 && +f[2] > 0) return fractional(+f[2], +f[1]);
  return null;
}

/** Abbreviated value (an economic series): from 1,000 on, at most 2 decimals and K / M / B / T after a space
 *  ("159.04 M", "−34 K"); below, the `small` format. */
export function abbreviatedPrice(v: number, small: (v: number) => string): string {
  const a = Math.abs(v);
  if (!(a >= 1e3)) return small(v);
  const [div, letter] = a >= 1e12 ? [1e12, "T"] : a >= 1e9 ? [1e9, "B"] : a >= 1e6 ? [1e6, "M"] : [1e3, "K"];
  return `${v < 0 ? MINUS : ""}${+(a / div).toFixed(2)} ${letter}`;
}

/** Fractional format (the reference price formatter, fractional mode):
 *  `<integer>'<fraction>` with the fraction in steps of minMove/priceScale,
 *  zero-padded to the digit count of priceScale (2/4/8: 1 digit, 16/32/64: 2,
 *  128/320: 3). Halves and quarters are written in tenths ("5"; "2", "5",
 *  "7"). Examples: 1/32 123.5 → "123'16", 1/4 123.25 → "123'2". */
function fractional(priceScale: number, minMove: number): ChartPriceFormat {
  const steps = priceScale / minMove;
  let digits = 1;
  for (let v = priceScale; v > 10; v /= 10) digits++;
  const tenths = priceScale === 2 ? [0, 5] : priceScale === 4 ? [0, 2, 5, 7] : null;
  return {
    minMove: minMove / priceScale,
    format: (price) => {
      const neg = price < 0;
      const a = Math.abs(price);
      let int = Math.floor(a);
      let frac = Math.round(a * steps) - int * steps;
      if (frac >= steps) {
        frac = 0;
        int += 1;
      }
      const shown = (tenths ? tenths[frac] ?? frac : frac) * minMove;
      const text = `${groupThousands(String(int))}'${String(shown).padStart(digits, "0")}`;
      return neg ? MINUS + text : text;
    },
  };
}

function fixed(decimals: number): ChartPriceFormat {
  return { format: (v) => groupThousands(v.toFixed(decimals)), minMove: 1 / 10 ** decimals };
}
