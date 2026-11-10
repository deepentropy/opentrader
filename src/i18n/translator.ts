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
 */
export type Dictionary = Record<string, string>;

/** Attributes that show text. Not aria-label: the code finds some elements by it. */
const ATTRIBUTES = ["placeholder", "title"];

/** The attribute naming the sense of an element's words. */
const SENSE = "data-i18n-sense";

/** Elements whose text isn't interface text. */
const SKIP = "script,style,textarea,[contenteditable=true],.cm-editor,[data-no-translate]";

/** End of a text that the dictionary has without it. */
const ENDINGS = /(\s*(?:…|\.\.\.|:|：))$/;

const EMPTY: Dictionary = {};
let dictionary: Dictionary = EMPTY;
let rules: readonly ((text: string) => string)[] = [];

/** `textRules`: text holding a value (dates), tried when the dictionary doesn't have it. */
export function setDictionary(d: Dictionary, textRules: readonly ((text: string) => string)[] = []): void {
  // No dictionary and no rules: English.
  dictionary = Object.keys(d).length || textRules.length ? d : EMPTY;
  rules = textRules;
  drawn.clear();
}

/** A URL (an example address in a placeholder) is never translated. */
const URL_TEXT = /^[a-z][a-z\d+.-]*:\/\/\S+$/i;

/** A trimmed text the translator looks up: words, not numbers, symbols, single letters or a URL. */
export function translatable(core: string): boolean {
  return core.length >= 2 && /[A-Za-z]{2}/.test(core) && !URL_TEXT.test(core);
}

/**
 * The translation of a trimmed text, undefined when neither the dictionary nor a rule has it. With a `sense`, its own
 * entry first; the word's entry when the dictionary gives that sense no entry of its own.
 */
export function lookUp(core: string, d: Dictionary = dictionary, sense?: string): string | undefined {
  const entry = (text: string) => (sense === undefined ? undefined : d[`${text}|${sense}`]) ?? d[text];
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
  if (to === undefined) return text;
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

/**
 * A text holding values: the dictionary's translation of `template` ("{0} bars" → "{0} 根K线"), its `{0}`, `{1}`…
 * replaced by the values. The English template when the dictionary doesn't have it.
 */
export function translateWith(template: string, ...values: (string | number)[]): string {
  const to = dictionary === EMPTY ? template : (dictionary[template] ?? template);
  return to.replace(/\{(\d+)\}/g, (all, i) => (values[Number(i)] !== undefined ? String(values[Number(i)]) : all));
}

/** `fn` run with the English text (what the agent tools answer). */
export function inEnglish<T>(fn: () => T): T {
  const [d, r] = [dictionary, rules];
  dictionary = EMPTY;
  rules = [];
  try {
    return fn();
  } finally {
    dictionary = d;
    rules = r;
  }
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

function translateTextNode(node: Text): void {
  const text = node.data;
  if (written.get(node) === text || skipped(node.parentElement)) return;
  const to = translate(text, dictionary, senseOf(node.parentElement));
  if (to !== text) {
    written.set(node, to);
    node.data = to;
  }
}

function translateAttributes(el: Element): void {
  for (const name of ATTRIBUTES) {
    const value = el.getAttribute(name);
    if (!value) continue;
    const to = translate(value, dictionary, senseOf(el));
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
