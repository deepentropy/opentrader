import { afterEach, describe, expect, it } from "vitest";
import { languageEntry, menuLanguages } from "../languages";
import { PSEUDO_CLOSE, PSEUDO_OPEN, pseudo, pseudoDictionary } from "../pseudo";
import { setDictionary, translate, translateAs, translatePlural, translateWith } from "../translator";
import type { Catalog } from "../tools/catalog";

const unmarked = (s: string) => s.slice(PSEUDO_OPEN.length, -PSEUDO_CLOSE.length);

describe("the pseudo-language (#289)", () => {
  afterEach(() => setDictionary({}));

  it("accents a text, makes it longer and puts it between markers", () => {
    const t = pseudo("Save layout");
    expect(t.startsWith(PSEUDO_OPEN) && t.endsWith(PSEUDO_CLOSE)).toBe(true);
    expect(unmarked(t).startsWith("Šàṽé ļàýöüţ")).toBe(true);
    expect(/[A-Za-z]/.test(t)).toBe(false);
    const grown = unmarked(t).length / "Save layout".length - 1;
    expect(grown).toBeGreaterThanOrEqual(0.3);
    expect(grown).toBeLessThanOrEqual(0.5);
    expect(unmarked(pseudo("OK")).length).toBeGreaterThanOrEqual(4);
  });

  it("keeps the values and the ending", () => {
    expect(pseudo("{0} bars of {1}")).toMatch(/^⟦\{0\} ƀàŕš öƒ \{1\}.*⟧$/);
    expect(pseudo("Alert on {{ticker}}")).toContain("{{ticker}}");
    expect(pseudo("Save…").endsWith("…⟧")).toBe(true);
    expect(pseudo("Price:").endsWith(":⟧")).toBe(true);
  });

  it("writes each piece right to left with rtl, the values left as they are", () => {
    const t = pseudo("{0} bars", { rtl: true });
    expect(t).toMatch(/^⟦\{0\}‮ ƀàŕš‬‮.*‬⟧$/);
  });

  it("is generated from the catalog: texts, senses and plural forms", () => {
    const catalog: Catalog = {
      Save: { at: [] },
      "Post|action": { at: [], sense: "action" },
      "{0} bars": { at: [], values: ["{0}"], plural: { one: "{0} bar", other: "{0} bars" } },
      "{0} of {1}": { at: [], values: ["{0}", "{1}"] },
    };
    const d = pseudoDictionary(catalog);
    expect(Object.keys(d).sort()).toEqual(["Post", "Post|action", "Save", "{0} bars", "{0} of {1}"]);
    setDictionary(d, [], "en");
    expect(translate("Save")).toBe(pseudo("Save"));
    expect(translateAs("Post", "action")).toBe(pseudo("Post"));
    expect(translatePlural(1, { one: "{0} bar", other: "{0} bars" })).toBe(pseudo("{0} bar").replace("{0}", "1"));
    expect(translatePlural(3, { one: "{0} bar", other: "{0} bars" })).toBe(pseudo("{0} bars").replace("{0}", "3"));
    expect(translateWith("{0} of {1}", 2, 9)).toBe(pseudo("{0} of {1}").replace("{0}", "2").replace("{1}", "9"));
  });

  it("is registered without a dictionary file, in the menu of a development build", () => {
    const l = languageEntry("en-XA");
    expect(l?.pseudo).toBe(true);
    expect(l?.partial).toBeUndefined();
    expect(menuLanguages().some((x) => x.id === "en-XA")).toBe(import.meta.env.DEV);
  });
});
