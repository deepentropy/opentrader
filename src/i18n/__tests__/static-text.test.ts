import { describe, expect, it } from "vitest";
import { setDictionary, translate } from "../translator";
import zhHans from "../zh-Hans.json";
import { SIMPLIFIED_RULES } from "../zh-patterns";
import { staticTexts } from "./static-text";
import baseline from "./untranslated-baseline.json";

// The app's components; the website (community-site) is not translated.
const SOURCES = import.meta.glob(["../../**/*.tsx", "!../../community-site/**", "!../../**/__tests__/**"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** Text the translator looks up (it leaves symbols, numbers and single letters alone). */
const words = (text: string) => text.length >= 2 && /[A-Za-z]{2}/.test(text);

/** Static interface text the Simplified Chinese dictionary (and its rules) leaves in English. */
function untranslated(): Map<string, string> {
  setDictionary(zhHans, SIMPLIFIED_RULES);
  const missing = new Map<string, string>();
  for (const [file, source] of Object.entries(SOURCES)) {
    for (const t of staticTexts(file.replace(/^(\.\.\/)+/, "src/"), source)) {
      if (words(t.text) && translate(t.text) === t.text && !missing.has(t.text)) missing.set(t.text, `${t.file}:${t.line}`);
    }
  }
  setDictionary({});
  return missing;
}

describe("static interface text in zh-Hans", () => {
  it("reads JSX text and the title / placeholder attributes", () => {
    const found = staticTexts(
      "x.tsx",
      `const a = <div title="Close menu" placeholder={"Search"}>
        Save
        layout <b>{n}</b> &gt; more
        <Tip text="not an attribute" />
      </div>;`,
    ).map((t) => t.text);
    expect(found).toEqual(["Close menu", "Search", "Save layout", "> more"]);
  });

  // The text left in English when this test came: listed so that only new text fails. Translate a listed text and
  // drop it from untranslated-baseline.json.
  it("has every new text in the dictionary", () => {
    const known = new Set(baseline as string[]);
    const added = [...untranslated()].filter(([text]) => !known.has(text)).map(([text, at]) => `${at}  ${JSON.stringify(text)}`);
    expect(added, "text missing from src/i18n/zh-Hans.json (and zh-Hant.json)").toEqual([]);
  });
});
