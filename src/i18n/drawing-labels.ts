/*
 * The text the drawings draw on the chart in the interface language (#190): the drawing library hands each label
 * to the chart (`formatLabel`) with its English text and raw values, before measuring it. The text the user typed
 * is not a label: it stays as written.
 */
import type { DrawingLabel, LabelFormatter } from "lightweight-charts-drawing/core/labels";
import { translate, translateWith, translating } from "./translator";

/** Units of a time span ("1d 2h 30m"). */
const SPAN_UNIT_TEXTS: Record<string, string> = { d: "{0}d", h: "{0}h", m: "{0}m", s: "{0}s" };

/** "1d 2h 30m" with each unit translated. */
function timeSpan(text: string): string {
  return text.replace(/(\d[\d,]*)([dhms])\b/g, (_, n, u) => translateWith(SPAN_UNIT_TEXTS[u], n));
}

/** The field names of the position labels ("Target: 30.00, Amount: 1500"). */
const FIELDS = /\b(Target|Stop|Amount|Open PnL|Closed PnL|PnL|Qty|Risk\/reward ratio): /g;

function label(l: DrawingLabel): string | undefined {
  switch (l.id) {
    case "caption":
      return translate(l.text);
    case "bars-range":
      return translateWith("{0} bars", l.bars);
    case "time-span":
      return l.text ? timeSpan(l.text) : undefined;
    case "distance":
      return translateWith("distance: {0} px", l.distancePx);
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
