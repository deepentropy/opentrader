/*
 * The right-to-left pseudo-language, en-XB (#290), in the development build only: the English catalog written so that
 * the page runs right to left as it would in Arabic or Hebrew, while staying readable by anyone.
 *
 * Each text is put inside ⟦ ⟧ and each of its words is followed by a right-to-left mark (U+200F, invisible): the words
 * keep their letters but their order runs right to left ("Add alert" shows "alert Add", read from the right), the
 * brackets turn around, values and numbers placed in a text go through the bidirectional algorithm as they would in
 * a real right-to-left language, and the page's direction is rtl. Nothing else changes: the formats are English.
 *
 * What to look for: a text without the brackets isn't in the catalog (or was joined from pieces); a value broken
 * apart or moved to the wrong end ("12.5 %" split, a price cut in two) wasn't isolated; a panel on the wrong side,
 * a menu opening off-screen, an arrow pointing back instead of forward.
 */
import type { Catalog } from "./tools/catalog";
import type { Dictionary, PluralEntry } from "./translator";

const RLM = "‏";

/** A text in the pseudo-language: "Add alert" → "‏⟦Add‏ alert‏⟧‏". Placeholders ({0}, {{ticker}}) are kept whole. */
export function pseudoRtl(text: string): string {
  const words = text.split(" ").map((w) => (w ? w + RLM : w));
  return `${RLM}⟦${words.join(" ")}⟧${RLM}`;
}

/** The pseudo-language's dictionary: every text of the catalog, each plural form, each sense. */
export function pseudoRtlDictionary(catalog: Catalog): Dictionary {
  const d: Dictionary = {};
  for (const [key, entry] of Object.entries(catalog)) {
    if (entry.plural) {
      const forms: PluralEntry = { one: pseudoRtl(entry.plural.one), other: pseudoRtl(entry.plural.other) };
      d[key] = forms;
    } else {
      // "Close|action": the word, without its sense.
      d[key] = pseudoRtl(entry.sense && key.endsWith(`|${entry.sense}`) ? key.slice(0, -(entry.sense.length + 1)) : key);
    }
  }
  return d;
}

/** The registry's loader: the dictionary built from the catalog when the language is picked. */
export async function loadPseudoRtl(): Promise<{ default: Dictionary }> {
  const { default: catalog } = await import("./catalog.json");
  return { default: pseudoRtlDictionary(catalog as Catalog) };
}
