/*
 * The pseudo-languages (#289): test languages generated from the English catalog when they load, no dictionary to
 * keep. Each text is accented ("Save" → "Šàṽé"), made about a third longer and put between markers ("⟦Šàṽé ļ⟧"):
 * text on screen without the markers was not translated, text cut by its box shows the markers or the padding cut.
 * The values ({0}, {1}…, a message's {{ticker}}) and the plural forms are kept. The right-to-left pseudo-language is
 * pseudo-rtl.ts: readable words, for checking a mirrored page.
 *
 * Development builds list them in the language menu; a production build loads one only from the saved choice
 * (kv `ot:language`).
 */
import type { Catalog } from "./tools/catalog";
import { ENDINGS, type Dictionary } from "./translator";

export const PSEUDO_OPEN = "⟦";
export const PSEUDO_CLOSE = "⟧";

const ACCENTED: Record<string, string> = Object.fromEntries(
  [..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"].map((c, i) => [c, [..."àƀçďéƒğĥïĵķļɱñöþǫŕšţüṽŵẋýžÀƁÇĎÉƑĞĤÏĴĶĻṀÑÖÞǪŔŠŢÜṼŴẊÝŽ"][i]]),
);

/** The padding: accented words, as wide as a translation's extra text. */
const FILLER = " ļöŕéɱ ïþšüɱ ďöļöŕ šïţ àɱéţ çöñšéçţéţüŕ àďïþïšçïñğ éļïţ šéď ďö éïüšɱöď ţéɱþöŕ";

/** The values a text keeps as they are: {0}, {1}…, a message's {{ticker}}. */
const VALUE = /\{\{[^{}]*\}\}|\{\d+\}/g;

/** The text's letters accented, its values kept. */
function accent(text: string): string {
  const pieces = text.split(VALUE);
  const values = text.match(VALUE) ?? [];
  const write = (piece: string) => [...piece].map((c) => ACCENTED[c] ?? c).join("");
  return pieces.map((p, i) => write(p) + (values[i] ?? "")).join("");
}

/** How many characters a text of `n` grows by: about 40% for a short one, 30% for a longer one, two at least. */
function growth(n: number): number {
  return Math.max(2, Math.round(n * (n <= 12 ? 0.4 : 0.3)));
}

/** A text in the pseudo-language: `pseudo("Save…")` → "⟦Šàṽé ļ…⟧". */
export function pseudo(text: string): string {
  // "Save…", "Price:": the ending stays at the end, after the padding.
  const end = ENDINGS.exec(text)?.[1] ?? "";
  const core = end ? text.slice(0, -end.length) : text;
  const shown = core.replace(VALUE, "").length;
  const pad = FILLER.slice(0, growth(shown)).trimEnd();
  return PSEUDO_OPEN + accent(core) + pad + end + PSEUDO_CLOSE;
}

/** The pseudo dictionary of a catalog: each text, each sense, each plural form. */
export function pseudoDictionary(catalog: Catalog): Dictionary {
  const d: Dictionary = {};
  for (const [key, entry] of Object.entries(catalog)) {
    if (entry.plural) d[key] = { one: pseudo(entry.plural.one), other: pseudo(entry.plural.other) };
    else if (entry.sense) {
      // "Post|action": the word's entry too, the one the sense falls back to.
      const word = key.slice(0, key.lastIndexOf("|"));
      d[key] = pseudo(word);
      d[word] ??= pseudo(word);
    } else d[key] = pseudo(key);
  }
  return d;
}

/** A pseudo-language's dictionary, as a registry entry loads it (the catalog is read when the language is on). */
export async function loadPseudoDictionary(): Promise<{ default: Dictionary }> {
  const { default: catalog } = await import("./catalog.json");
  return { default: pseudoDictionary(catalog as Catalog) };
}
