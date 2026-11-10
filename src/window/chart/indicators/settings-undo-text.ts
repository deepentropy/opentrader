import { translate, translateWith } from "../../../i18n/translator";
/*
 * The undo text of one change in a study's Settings dialog, by what changed (the reference app's texts): an input
 * ("change <input> property"), a plot's visibility, colour, thickness, plot type or price line, the precision or
 * the values in the status line; anything else is "change <study> style". `key` names the field, so that the
 * keystrokes of one field make one undo step.
 */
import type { IndicatorStyleOverrides, PlotStyleOverride } from "./indicator-layer";
import type { IndicatorOptions } from "./indicator-options";

type Settings = { inputs: Record<string, unknown>; styles: IndicatorStyleOverrides; options: IndicatorOptions };

/** Plot fields and their texts, in the order they are looked at. */
const STYLE_TEXTS: [keyof PlotStyleOverride, string][] = [
  ["visible", "change visibility"],
  ["color", "change color"],
  ["palette", "change color"],
  ["colorUp", "change color"],
  ["colorDown", "change color"],
  ["lineWidth", "change thickness"],
  ["plotType", "change plot type"],
  ["priceLine", "change price line visibility"],
];
const OPTION_TEXTS: [keyof IndicatorOptions, string][] = [
  ["precision", "change precision"],
  ["valuesInStatusLine", "change values visibility"],
];

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function settingsUndoText(
  was: Settings,
  next: Settings,
  inputs: { id: string; title?: string }[],
  studyTitle: string,
): { key: string; label: string } {
  const input = inputs.find((c) => !same(next.inputs[c.id], was.inputs[c.id]));
  if (input) return { key: `input:${input.id}`, label: translateWith("change {0} property", translate(input.title || input.id)) };
  for (const plot of new Set([...Object.keys(was.styles ?? {}), ...Object.keys(next.styles ?? {})])) {
    const a = was.styles?.[plot] ?? {};
    const b = next.styles?.[plot] ?? {};
    if (same(a, b)) continue;
    const hit = STYLE_TEXTS.find(([f]) => !same(a[f], b[f]));
    return hit ? { key: `style:${plot}:${hit[0]}`, label: hit[1] } : { key: `style:${plot}`, label: translateWith("change {0} style", translate(studyTitle)) };
  }
  const opt = OPTION_TEXTS.find(([f]) => !same(was.options?.[f], next.options?.[f]));
  if (opt) return { key: `option:${opt[0]}`, label: opt[1] };
  return { key: "other", label: translateWith("change {0} style", translate(studyTitle)) };
}
