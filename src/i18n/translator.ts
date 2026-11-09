/*
 * The interface in another language (#189): a dictionary from the English text to the translation, applied to the
 * page's text as it appears. The components keep their English text, English users load none of this.
 *
 * Not translated: what the user typed (inputs, the script editor), and text drawn on a canvas unless the chart asks
 * with `translate`.
 */
export type Dictionary = Record<string, string>;

/** Attributes that show text. Not aria-label: the code finds some elements by it. */
const ATTRIBUTES = ["placeholder", "title"];

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

/** The translation of a text, its spaces around kept; the text itself when the dictionary doesn't have it. */
export function translate(text: string, d: Dictionary = dictionary): string {
  const core = text.trim();
  if (core.length < 2 || !/[A-Za-z]{2}/.test(core) || d === EMPTY) return text;
  let to = d[core];
  if (to === undefined) {
    // "Save…" with "Save" in the dictionary, and the other way round.
    const end = ENDINGS.exec(core);
    if (end) {
      const base = d[core.slice(0, -end[1].length)];
      if (base !== undefined) to = base + end[1];
    }
    if (to === undefined) {
      const rewritten = rules.reduce((t, rule) => rule(t), core);
      if (rewritten === core) return text;
      to = rewritten;
    }
  }
  return core === text ? to : text.replace(core, () => to as string);
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

function translateTextNode(node: Text): void {
  const text = node.data;
  if (written.get(node) === text || skipped(node.parentElement)) return;
  const to = translate(text);
  if (to !== text) {
    written.set(node, to);
    node.data = to;
  }
}

function translateAttributes(el: Element): void {
  for (const name of ATTRIBUTES) {
    const value = el.getAttribute(name);
    if (!value) continue;
    const to = translate(value);
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
