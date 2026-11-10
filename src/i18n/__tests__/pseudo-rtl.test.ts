import { describe, expect, it } from "vitest";
import catalogJson from "../catalog.json";
import { languageEntry } from "../languages";
import { pseudoRtl, pseudoRtlDictionary } from "../pseudo-rtl";
import type { Catalog } from "../tools/catalog";
import { valuesOf } from "../tools/catalog";

const RLM = String.fromCharCode(0x200f);
const plain = (s: string) => s.split(RLM).join("");

describe("the right-to-left pseudo-language en-XB (#290)", () => {
  it("is registered in the development build, right to left, English formats", () => {
    const l = languageEntry("en-XB")!;
    expect(l.direction).toBe("rtl");
    expect(l.pseudo).toBe(true);
    expect(l.formats).toEqual(languageEntry("en")!.formats);
  });

  it("keeps the words and the values, each word followed by a right-to-left mark, inside ⟦ ⟧", () => {
    expect(pseudoRtl("Add alert")).toBe(`${RLM}⟦Add${RLM} alert${RLM}⟧${RLM}`);
    expect(plain(pseudoRtl("{0} bars of {1}"))).toBe("⟦{0} bars of {1}⟧");
    expect(plain(pseudoRtl("Extend Left    |    Extend Right"))).toBe("⟦Extend Left    |    Extend Right⟧");
  });

  it("gives every catalog text, its plural forms and its senses, with the same values", () => {
    const catalog = catalogJson as Catalog;
    const d = pseudoRtlDictionary(catalog);
    expect(Object.keys(d).sort()).toEqual(Object.keys(catalog).sort());
    for (const [key, entry] of Object.entries(catalog)) {
      const to = d[key];
      if (entry.plural) {
        expect(typeof to === "object" && plain(to.one!)).toBe(`⟦${entry.plural.one}⟧`);
      } else {
        const text = entry.sense ? key.slice(0, -(entry.sense.length + 1)) : key;
        expect(plain(to as string), key).toBe(`⟦${text}⟧`);
        expect(valuesOf(to as string)).toEqual(valuesOf(text));
      }
    }
  });
});
