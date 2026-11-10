import { describe, expect, it } from "vitest";
import { lookUp, setDictionary, translatable, translate } from "../translator";
import zhHans from "../zh-Hans.json";
import { SIMPLIFIED_RULES } from "../zh-patterns";
import { staticTexts } from "./static-text";

// The app's components; the website (community-site) is not translated.
const SOURCES = import.meta.glob(["../../**/*.tsx", "!../../community-site/**", "!../../**/__tests__/**"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/**
 * Static interface text the Simplified Chinese dictionary (and its rules) doesn't have. A text kept as it is (a
 * ticker, a unit, a key name) is in the dictionary as itself, so it counts as known.
 */
function untranslated(): Map<string, string> {
  setDictionary(zhHans, SIMPLIFIED_RULES);
  const missing = new Map<string, string>();
  for (const [file, source] of Object.entries(SOURCES)) {
    for (const t of staticTexts(file.replace(/^(\.\.\/)+/, "src/"), source)) {
      if (translatable(t.text) && lookUp(t.text) === undefined && !missing.has(t.text)) missing.set(t.text, `${t.file}:${t.line}`);
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

  it("leaves URLs alone", () => {
    expect(translatable("https://example.com/alert-hook")).toBe(false);
    expect(translate("https://example.com/hook", { "https://example.com/hook": "x" })).toBe("https://example.com/hook");
    expect(translatable("Webhook URL")).toBe(true);
  });

  it("has every text in the dictionary", () => {
    const missing = [...untranslated()].map(([text, at]) => `${at}  ${JSON.stringify(text)}`);
    expect(missing, "text missing from src/i18n/zh-Hans.json (and zh-Hant.json)").toEqual([]);
  });
});
