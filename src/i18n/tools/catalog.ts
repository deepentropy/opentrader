/*
 * The English catalog (#288): every text the interface can show in another language, keyed as the dictionaries key
 * it, with where it comes from. Built by `npm run i18n:extract` from three sources:
 * - the app's code (scan.ts): JSX text, text props and fields, the texts given to the translator;
 * - the built-in studies of the indicator library (study-texts.ts): names, inputs, plots, alert conditions;
 * - the texts only known at run time (run-time-texts.ts): drawn by a library, or sent by the data server.
 *
 * The tests compare each dictionary with it: a text missing, an entry the catalog no longer has (obsolete), values
 * ({0}, {1}…) that differ, a sense without its word, a plural with forms the language doesn't have.
 */
import { ENDINGS, translatable, type Dictionary } from "../translator";
import type { PluralForms, StaticText } from "./scan";

export type CatalogEntry = {
  /** Where the text is used: "window/chart/menus.tsx:134", "studies: macd plot", "run time: …" (the first few). */
  at: string[];
  /** How many places use it, when more than `at` lists. */
  uses?: number;
  /** The values it holds: "{0}", "{1}". */
  values?: string[];
  /** The word's sense ("action" for "Post|action"). */
  sense?: string;
  /** The English forms of a counted text; the key is the `other` form. */
  plural?: PluralForms;
};

export type Catalog = Record<string, CatalogEntry>;

/** A text from outside the code: where it was found ("studies: macd plot"). */
export type FoundText = { text: string; at: string };

const AT_MOST = 3;

/** The values of a text: `{0}`, `{1}`… (not a message's `{{ticker}}`), sorted. */
export function valuesOf(text: string): string[] {
  return [...new Set(text.match(/(?<!\{)\{\d+\}(?!\})/g) ?? [])].sort();
}

/** The dictionary key of a static text: "Post|action" for a word given a sense, the text itself otherwise. */
export function keyOf(t: { text: string; sense?: string }): string {
  return t.sense && !t.text.includes(" ") ? `${t.text}|${t.sense}` : t.text;
}

/** A text to translate: one the page translator looks up, or a template whose words are short ("{0}d"). */
function worded(text: string): boolean {
  return translatable(text) || (valuesOf(text).length > 0 && /[A-Za-z]/.test(text));
}

/** The catalog of the texts found, sorted by key. */
export function buildCatalog(code: StaticText[], studies: FoundText[], runTime: FoundText[]): Catalog {
  const out = new Map<string, CatalogEntry>();
  const uses = new Map<string, Set<string>>();
  const add = (key: string, at: string, extra: Partial<CatalogEntry> = {}) => {
    let e = out.get(key);
    if (!e) {
      const values = valuesOf(key);
      e = { at: [], ...(values.length ? { values } : {}), ...extra };
      out.set(key, e);
      uses.set(key, new Set());
    } else if (extra.plural && !e.plural) e.plural = extra.plural;
    uses.get(key)!.add(at);
    if (e.at.length < AT_MOST && !e.at.includes(at)) e.at.push(at);
  };
  for (const t of code) {
    if (!worded(t.text)) continue;
    const at = `${t.file.replace(/^src\//, "")}:${t.line}`;
    const key = keyOf(t);
    add(key, at, { ...(t.sense && key.includes("|") ? { sense: t.sense } : {}), ...(t.plural ? { plural: t.plural } : {}) });
  }
  for (const t of [...studies, ...runTime]) {
    const sense = /^[^|]+\|([a-z]+)$/.exec(t.text)?.[1];
    if (worded(t.text)) add(t.text, t.at, sense ? { sense } : {});
  }
  for (const [key, e] of out) if (uses.get(key)!.size > e.at.length) e.uses = uses.get(key)!.size;
  return Object.fromEntries([...out].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** The catalog as committed: one entry per line, so a change reads as the lines it adds or removes. */
export function serializeCatalog(catalog: Catalog): string {
  const lines = Object.entries(catalog).map(([k, e]) => `  ${JSON.stringify(k)}: ${JSON.stringify(e)}`);
  return `{\n${lines.join(",\n")}\n}\n`;
}

/** The dictionary has the text, or has it without its ending ("Save" for "Save…"), as the translator looks it up. */
export function hasText(d: Dictionary, key: string): boolean {
  if (key in d) return true;
  const end = ENDINGS.exec(key);
  return !!end && key.slice(0, -end[1].length) in d;
}

/**
 * The catalog uses the entry: as it is, with an ending the translator adds ("Save" for "Save…"), or as the word of a
 * sense ("Post" for "Post|action", the entry a sense falls back to).
 */
function used(catalog: Catalog, key: string, bases: Set<string>): boolean {
  return key in catalog || bases.has(key);
}

export type Problems = {
  /** Catalog texts the dictionary lacks. */
  missing: string[];
  /** Dictionary entries no text of the catalog (nor of a study) uses. */
  obsolete: string[];
  /** Entries whose values differ from the English ({0}, {1}…). */
  values: string[];
  /** "word|sense" entries without the word's own entry. */
  senses: string[];
  /** Plural entries with a form the language doesn't have, or none for `other`; plain texts given forms. */
  plurals: string[];
};

/**
 * What a dictionary lacks or has too much against the catalog. `categories`: the language's plural categories
 * (Intl.PluralRules); `known`: texts a dictionary may translate beyond the catalog (the studies' other texts).
 */
export function checkDictionary(catalog: Catalog, d: Dictionary, categories: readonly string[], known: ReadonlySet<string> = new Set()): Problems {
  const bases = new Set<string>();
  for (const [key, e] of Object.entries(catalog)) {
    const end = ENDINGS.exec(key);
    if (end) bases.add(key.slice(0, -end[1].length));
    if (e.sense) bases.add(key.slice(0, key.indexOf("|")));
  }
  const p: Problems = { missing: [], obsolete: [], values: [], senses: [], plurals: [] };
  for (const key of Object.keys(catalog)) if (!hasText(d, key)) p.missing.push(key);
  for (const [key, to] of Object.entries(d)) {
    if (!used(catalog, key, bases) && !known.has(key)) p.obsolete.push(key);
    const english = valuesOf(key).join(" ");
    const forms = typeof to === "string" ? [to] : Object.values(to);
    if (forms.some((f) => valuesOf(f ?? "").join(" ") !== english)) p.values.push(key);
    const bar = key.indexOf("|");
    if (bar > 0 && /^[a-z]+$/.test(key.slice(bar + 1)) && !(key.slice(0, bar) in d)) p.senses.push(key);
    if (typeof to === "object") {
      const ok = catalog[key]?.plural && "other" in to && Object.keys(to).every((c) => categories.includes(c));
      if (!ok) p.plurals.push(key);
    } else if (catalog[key]?.plural && categories.length > 1) p.plurals.push(key);
  }
  return p;
}

/** Share of the catalog a dictionary covers, in percent with one decimal. */
export function coverage(catalog: Catalog, d: Dictionary): number {
  const keys = Object.keys(catalog);
  const have = keys.filter((k) => hasText(d, k)).length;
  return keys.length ? Math.round((have / keys.length) * 1000) / 10 : 100;
}
