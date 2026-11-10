/*
 * The interface in another language (#189): a dictionary from the English text to the translation, applied to the
 * page's text as it appears. The components keep their English text, English users load none of this.
 *
 * Not translated: what the user typed (inputs, the script editor), and text drawn on a canvas unless the chart asks
 * with `translate`.
 *
 * A word with two meanings has one entry per sense (#285): "Post" is after-hours on the chart, publish on the community
 * button. The dictionary keeps the common sense under the word and another under "word|sense" ("Post|action"). An
 * element names its sense with `data-i18n-sense="action"`: its text, title and placeholder, and those of the elements
 * inside, are looked up as "Post|action" first, then as "Post". Text a component shows elsewhere (a tooltip, a menu
 * row) goes through `translateAs`.
 *
 * A text holding a count has one form per plural category of the language (#288): the dictionary keys it by its
 * English "other" form ("{0} bars") and gives either one text, for a language with one form (Chinese), or the forms
 * by category ({ "one": …, "other": … }, Intl.PluralRules' names). The code asks through `translatePlural`.
 */
import { ENGLISH, type Formats } from "./languages";

/** A text's forms by plural category; `other` is the one every language has. */
export type PluralEntry = Partial<Record<Intl.LDMLPluralRule, string>> & { other: string };

export type Dictionary = Record<string, string | PluralEntry>;

/** Attributes that show text. Not aria-label: the code finds some elements by it. */
const ATTRIBUTES = ["placeholder", "title"];

/** The attribute naming the sense of an element's words. */
const SENSE = "data-i18n-sense";

/** Elements whose text isn't interface text. */
const SKIP = "script,style,textarea,[contenteditable=true],.cm-editor,[data-no-translate]";

/** End of a text that the dictionary has without it. */
export const ENDINGS = /(\s*(?:…|\.\.\.|:|：))$/;

const EMPTY: Dictionary = {};
let dictionary: Dictionary = EMPTY;
let rules: readonly ((text: string) => string)[] = [];
/** English picks between the two forms the code writes. */
const ENGLISH_PLURALS = new Intl.PluralRules(ENGLISH.pluralLocale);
let pluralRules = ENGLISH_PLURALS;
let formats: Formats = ENGLISH.formats;

/**
 * `textRules`: text holding a value, tried when the dictionary doesn't have it. `pluralLocale` picks the forms of
 * counted texts, `languageFormats` the dates and numbers (format.ts).
 */
export function setDictionary(d: Dictionary, textRules: readonly ((text: string) => string)[] = [], pluralLocale = ENGLISH.pluralLocale, languageFormats = ENGLISH.formats): void {
  // No dictionary and no rules: English.
  dictionary = Object.keys(d).length || textRules.length ? d : EMPTY;
  rules = textRules;
  pluralRules = new Intl.PluralRules(pluralLocale);
  formats = languageFormats;
  drawn.clear();
}

/** The formats of the interface language (English inside `inEnglish`). */
export function activeFormats(): Formats {
  return formats;
}

/** A URL (an example address in a placeholder) is never translated. */
const URL_TEXT = /^[a-z][a-z\d+.-]*:\/\/\S+$/i;

/** A trimmed text the translator looks up: words, not numbers, symbols, single letters or a URL. */
export function translatable(core: string): boolean {
  return core.length >= 2 && /[A-Za-z]{2}/.test(core) && !URL_TEXT.test(core);
}

/** An entry's text where one form is asked for: its "other" form when it has several. */
const textOf = (entry: string | PluralEntry | undefined): string | undefined => (typeof entry === "object" ? entry.other : entry);

/**
 * The translation of a trimmed text, undefined when neither the dictionary nor a rule has it. With a `sense`, its own
 * entry first; the word's entry when the dictionary gives that sense no entry of its own.
 */
export function lookUp(core: string, d: Dictionary = dictionary, sense?: string): string | undefined {
  const entry = (text: string) => textOf((sense === undefined ? undefined : d[`${text}|${sense}`]) ?? d[text]);
  const to = entry(core);
  if (to !== undefined) return to;
  // "Save…" with "Save" in the dictionary, and the other way round.
  const end = ENDINGS.exec(core);
  if (end) {
    const base = entry(core.slice(0, -end[1].length));
    if (base !== undefined) return base + end[1];
  }
  const rewritten = rules.reduce((t, rule) => rule(t), core);
  return rewritten === core ? undefined : rewritten;
}

/** The translation of a text, its spaces around kept; the text itself when the dictionary doesn't have it. */
export function translate(text: string, d: Dictionary = dictionary, sense?: string): string {
  const core = text.trim();
  if (d === EMPTY || !translatable(core)) return text;
  const to = lookUp(core, d, sense);
  if (to === undefined) {
    if (import.meta.env.DEV && d === dictionary) missed(core);
    return text;
  }
  return core === text ? to : text.replace(core, () => to);
}

/** `translate` in the given sense ("Close", "action" → 关闭, not the closing price). */
export function translateAs(text: string, sense: string): string {
  return translate(text, dictionary, sense);
}

/** A language other than English is on (the code that translates text itself can skip the work otherwise). */
export function translating(): boolean {
  return dictionary !== EMPTY;
}

/** `template`'s `{0}`, `{1}`… replaced by the values; a placeholder without a value stays. */
function fill(template: string, values: readonly (string | number)[]): string {
  return template.replace(/\{(\d+)\}/g, (all, i) => (values[Number(i)] !== undefined ? String(values[Number(i)]) : all));
}

/**
 * A text holding values: the dictionary's translation of `template` ("{0} bars" → "{0} 根K线"), its `{0}`, `{1}`…
 * replaced by the values. The English template when the dictionary doesn't have it.
 */
export function translateWith(template: string, ...values: (string | number)[]): string {
  if (dictionary === EMPTY) return fill(template, values);
  const to = textOf(dictionary[template]);
  if (import.meta.env.DEV && to === undefined) missed(template);
  return fill(to ?? template, values);
}

/**
 * A text holding a count, in the form the language gives that count: `translatePlural(n, { one: "{0} bar", other:
 * "{0} bars" })`. The values fill the placeholders, the count alone when none are given (pass it formatted, "1,250",
 * among the values when the text shows it so).
 */
export function translatePlural(count: number, forms: { one: string; other: string }, ...values: (string | number)[]): string {
  const filled = values.length ? values : [count];
  const category = pluralRules.select(count);
  const entry = dictionary === EMPTY ? undefined : dictionary[forms.other];
  if (import.meta.env.DEV && dictionary !== EMPTY && entry === undefined) missed(forms.other);
  if (entry === undefined) return fill(ENGLISH_PLURALS.select(count) === "one" ? forms.one : forms.other, filled);
  return fill(typeof entry === "string" ? entry : (entry[category] ?? entry.other), filled);
}

/** `fn` run with the English text and formats (what the agent tools answer). */
export function inEnglish<T>(fn: () => T): T {
  const [d, r, p, f] = [dictionary, rules, pluralRules, formats];
  dictionary = EMPTY;
  rules = [];
  pluralRules = ENGLISH_PLURALS;
  formats = ENGLISH.formats;
  try {
    return fn();
  } finally {
    [dictionary, rules, pluralRules, formats] = [d, r, p, f];
  }
}

/*
 * The texts left in English, in the development build (#288): each text the page, a canvas or the code asked for and
 * the dictionary lacked, once, with where it was seen. `window.__i18nMisses()` lists them; each is logged once with
 * console.debug. Recorded once the page is translated (observePage), so tests stay quiet; a production build leaves
 * it out (import.meta.env.DEV is false there, the calls are dropped).
 */
const misses = new Map<string, string>();
let recording = false;

/** The element path of a node ("div.chart-legend > span"), for the miss list. */
function pathOf(el: Element | null): string {
  const parts: string[] = [];
  for (let e = el; e && e !== document.body && parts.length < 4; e = e.parentElement) {
    const cls = typeof e.className === "string" ? e.className.trim().split(/\s+/)[0] : "";
    parts.unshift(e.tagName.toLowerCase() + (cls ? `.${cls}` : ""));
  }
  return parts.join(" > ");
}

function missed(text: string, el?: Element | null): void {
  if (!recording || misses.has(text)) return;
  const where = el ? pathOf(el) : "code or canvas";
  misses.set(text, where);
  console.debug("[i18n] untranslated:", JSON.stringify(text), where);
}

if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as { __i18nMisses: () => { text: string; where: string }[] }).__i18nMisses = () =>
    [...misses].map(([text, where]) => ({ text, where }));
}

/** Translations of text drawn on a canvas, each line on its own (the same texts come back on every paint). */
const drawn = new Map<string, string>();

/** `translate` of each line of a text drawn on a canvas, remembered. */
export function translateDrawn(text: string): string {
  if (dictionary === EMPTY || text.length < 2) return text;
  let to = drawn.get(text);
  if (to === undefined) {
    to = text.includes("\n") ? text.split("\n").map((l) => translate(l)).join("\n") : translate(text);
    if (drawn.size > 5000) drawn.clear();
    drawn.set(text, to);
  }
  return to;
}

/** Translated text nodes: a node written by the translator isn't translated again. */
const written = new WeakMap<Node, string>();

function skipped(el: Element | null): boolean {
  return !el || el.closest(SKIP) !== null;
}

/** The sense an element or one around it gives its words. */
function senseOf(el: Element | null): string | undefined {
  return el?.closest(`[${SENSE}]`)?.getAttribute(SENSE) ?? undefined;
}

/** `translate` of a text on the page; a miss is recorded with its element. */
function translateOnPage(text: string, el: Element | null): string {
  const core = text.trim();
  if (!translatable(core)) return text;
  const to = lookUp(core, dictionary, senseOf(el));
  if (to === undefined) {
    if (import.meta.env.DEV) missed(core, el);
    return text;
  }
  return core === text ? to : text.replace(core, () => to);
}

function translateTextNode(node: Text): void {
  const text = node.data;
  if (written.get(node) === text || skipped(node.parentElement)) return;
  const to = translateOnPage(text, node.parentElement);
  if (to !== text) {
    written.set(node, to);
    node.data = to;
  }
}

function translateAttributes(el: Element): void {
  for (const name of ATTRIBUTES) {
    const value = el.getAttribute(name);
    if (!value) continue;
    const to = translateOnPage(value, el);
    if (to !== value) el.setAttribute(name, to);
  }
}

function translateTree(root: Node): void {
  if (root.nodeType === Node.TEXT_NODE) {
    translateTextNode(root as Text);
    return;
  }
  if (root.nodeType !== Node.ELEMENT_NODE) return;
  const el = root as Element;
  if (skipped(el)) return;
  translateAttributes(el);
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) translateTextNode(n as Text);
    else if (!skipped(n as Element)) translateAttributes(n as Element);
  }
}

/** Translates the page and everything added to it from now on (before it is painted). */
export function observePage(root: Node = document.documentElement): () => void {
  if (import.meta.env.DEV) recording = true;
  translateTree(root);
  const observer = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === "characterData") translateTextNode(r.target as Text);
      else if (r.type === "attributes") translateAttributes(r.target as Element);
      else r.addedNodes.forEach(translateTree);
    }
  });
  observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRIBUTES });
  return () => observer.disconnect();
}
