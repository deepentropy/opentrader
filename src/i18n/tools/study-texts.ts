/*
 * The texts of the indicator library's studies the interface shows: names, inputs (title, group, tooltip, options),
 * plots, levels, fills and alert conditions. The built-in studies' (standard and candlestick) are in the catalog,
 * without the texts that have no lowercase letter (ALMA, OHLC, SMA50: abbreviations read the same in every language).
 * The others are not required of a language, but a dictionary may translate them: the community studies are shown
 * as their texts are found on the page.
 */
import type { FoundText } from "./catalog";

type Titled = { title?: string };
type Input = Titled & { group?: string; tooltip?: string; options?: unknown[] };
/** What the catalog reads of a library entry. */
export type StudyEntry = {
  id: string;
  group: string;
  name: string;
  inputConfig?: Input[];
  plotConfig?: Titled[];
  hlineConfig?: Titled[];
  fillConfig?: Titled[];
  alertConditions?: Titled[];
};

const BUILT_IN = new Set(["standard", "candlestick"]);

function textsOf(e: StudyEntry): FoundText[] {
  const out: FoundText[] = [];
  const add = (text: unknown, what: string) => {
    if (typeof text === "string" && text.trim()) out.push({ text: text.trim(), at: `studies: ${e.id} ${what}` });
  };
  add(e.name, "name");
  for (const i of e.inputConfig ?? []) {
    add(i.title, "input");
    add(i.group, "group");
    add(i.tooltip, "tooltip");
    for (const o of i.options ?? []) add(o, "option");
  }
  for (const p of e.plotConfig ?? []) add(p.title, "plot");
  for (const h of e.hlineConfig ?? []) add(h.title, "level");
  for (const f of e.fillConfig ?? []) add(f.title, "fill");
  for (const a of e.alertConditions ?? []) add(a.title, "alert");
  return out;
}

/** The built-in studies' texts: the catalog's. */
export function studyTexts(registry: readonly StudyEntry[]): FoundText[] {
  return registry.filter((e) => BUILT_IN.has(e.group)).flatMap(textsOf).filter((t) => /[a-z]/.test(t.text));
}

/** Every study's texts: a dictionary may have them. */
export function knownStudyTexts(registry: readonly StudyEntry[]): Set<string> {
  return new Set(registry.flatMap(textsOf).map((t) => t.text));
}
