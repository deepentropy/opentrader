/*
 * The text the drawings draw on the chart in the interface language (#190): the drawing library hands each label
 * to the chart (`formatLabel`) with its English text and raw values, before measuring it. The text the user typed
 * is not a label: it stays as written.
 *
 * Their numbers (#291) are written by the library through the number format of the language (`drawingNumberFormat`):
 * the labels reach `formatLabel` with them ("1 234,56 (−5,81%)", "1 500 bars").
 */
import type { DrawingLabel, LabelFormatter } from "lightweight-charts-drawing/core/labels";
import { ENGLISH_NUMBER_FORMAT, type NumberFormat } from "lightweight-charts-drawing/core/numbers";
import { localNumber } from "./format";
import { activeFormats, translate, translateWith, translating } from "./translator";

/** Units of a time span ("1d 2h 30m"). */
const SPAN_UNIT_TEXTS: Record<string, string> = { d: "{0}d", h: "{0}h", m: "{0}m", s: "{0}s" };

/** "1d 2h 30m" with each unit translated. */
function timeSpan(text: string): string {
  return text.replace(/(\d[\d, ]*)([dhms])\b/g, (_, n, u) => translateWith(SPAN_UNIT_TEXTS[u], n));
}

/** "−1,234.50": the English number, thousands grouped, minus U+2212. */
function englishGrouped(v: number, digits: number): string {
  const [int, dec] = Math.abs(v).toFixed(digits).split(".");
  return `${v < 0 ? "−" : ""}${int.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${dec ? `.${dec}` : ""}`;
}

/** The drawings' numbers in the marks of the interface language: "1 234,56", "−5,81%", "103,47 M". */
const LANGUAGE_NUMBERS: NumberFormat = {
  formatNumber: (v, digits) => localNumber(englishGrouped(v, digits)),
  formatPercent: (v, digits) => localNumber(`${englishGrouped(v, digits)}%`),
  formatVolume: (v) => localNumber(ENGLISH_NUMBER_FORMAT.formatVolume(v)),
};

/** The drawings' number format: none in a language writing numbers as English does (the library's own text). */
export function drawingNumberFormat(): NumberFormat | undefined {
  return activeFormats().numberMarks ? LANGUAGE_NUMBERS : undefined;
}

/** The field names of the position labels ("Target: 30.00, Amount: 1500"). */
const FIELDS = /\b(Target|Stop|Amount|Open PnL|Closed PnL|PnL|Qty|Risk\/reward ratio): /g;

function label(l: DrawingLabel): string | undefined {
  switch (l.id) {
    case "caption":
      return translate(l.text);
    // The numbers as the library wrote them, in the language's marks ("1 500").
    case "bars-range":
      return translateWith("{0} bars", l.text.replace(/ bars$/, ""));
    case "time-span":
      return l.text ? timeSpan(l.text) : undefined;
    case "distance":
      return translateWith("distance: {0} px", l.text.replace(/^distance: | px$/g, ""));
    case "volume":
      // The volume profile's values are numbers alone.
      return l.text.startsWith("Vol ") ? translateWith("Vol {0}", l.text.slice(4)) : undefined;
    case "position-target":
    case "position-stop":
    case "position-middle":
      return l.text.replace(FIELDS, (_, name: string) => `${translate(name)}: `);
    case "forecast": {
      // "1.74 (7.04%) in 1d 21h 30m"
      const at = l.text.indexOf(" in ");
      return at < 0 ? undefined : translateWith("{0} in {1}", l.text.slice(0, at), timeSpan(l.text.slice(at + 4)));
    }
    default:
      // Numbers and dates, and the stats rows (joined from the labels above).
      return undefined;
  }
}

/** The drawings' label hook, none in English. */
export function drawingLabelFormatter(): LabelFormatter | undefined {
  if (!translating()) return undefined;
  return (l) => {
    const to = label(l);
    return to === l.text ? undefined : to;
  };
}
