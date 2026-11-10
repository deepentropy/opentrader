import { describe, expect, it } from "vitest";
import { lookUp, setDictionary, translatable, translate } from "../translator";
import zhHans from "../zh-Hans.json";
import { SIMPLIFIED_RULES } from "../zh-patterns";
import { staticTexts } from "./static-text";

/*
 * The app's components and the modules holding what they show (menus, tabs, dialogs). Not read: the website
 * (community-site, not translated), the tools of the agent and of the assistant (read by a model) and the exported
 * report (in English), the strategy engine (a worker, no page) and the generated bindings.
 */
const SOURCES = import.meta.glob(
  [
    "../../**/*.{ts,tsx}",
    "!../../**/*.d.ts",
    "!../../community-site/**",
    "!../../agent/**",
    "!../../data/assistant/**",
    "!../../backtester/**",
    "!../../window/strategy-tester/xlsx-report.ts",
    "!../../i18n/**",
    "!../../bindings.ts",
    "!../../**/__tests__/**",
  ],
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;

/**
 * Static interface text the Simplified Chinese dictionary (and its rules) doesn't have. A text kept as it is (a
 * ticker, a unit, a key name) is in the dictionary as itself, so it counts as known.
 */
function untranslated(): Map<string, string> {
  setDictionary(zhHans, SIMPLIFIED_RULES);
  const missing = new Map<string, string>();
  for (const [file, source] of Object.entries(SOURCES)) {
    for (const t of staticTexts(file.replace(/^(\.\.\/)+/, "src/"), source)) {
      // A word given a sense needs that sense's own entry: the word's entry is the other meaning. A phrase ("Post
      // idea") has one meaning, its own entry serves every sense, as it does on the page.
      const key = t.sense && !t.text.includes(" ") ? `${t.text}|${t.sense}` : t.text;
      if (translatable(t.text) && lookUp(key) === undefined && !missing.has(key)) missing.set(key, `${t.file}:${t.line}`);
    }
  }
  setDictionary({});
  return missing;
}

describe("static interface text in zh-Hans", () => {
  it("reads JSX text and the title / placeholder attributes", () => {
    const found = staticTexts(
      "x.tsx",
      `const a = <div title="Close menu" placeholder={"Search"} class="not-text" aria-label="Not translated">
        Save
        layout <b>{n}</b> &gt; more
      </div>;`,
    ).map((t) => t.text);
    expect(found).toEqual(["Close menu", "Search", "Save layout", "> more"]);
  });

  it("reads the strings a JSX expression shows, not those it compares or passes", () => {
    const found = staticTexts(
      "x.tsx",
      `const a = <div title={busy ? "Saving" : "Save"}>
        {kind === "log" ? "No events yet" : "No alerts yet"}
        {n > 0 && "Matches"}{name ?? "Unnamed"}{("Plain")}
        {label("Not shown as is")}{rows.map((r) => r.id)}
        <span class={on ? "is-on" : "is-off"} />
      </div>;`,
    ).map((t) => t.text);
    expect(found).toEqual(["Saving", "Save", "No events yet", "No alerts yet", "Matches", "Unnamed", "Plain"]);
  });

  it("reads the text fields of objects and the text props of components", () => {
    const found = staticTexts(
      "x.tsx",
      `const TABS = [{ id: "log", label: "Log", value: "Value" }, { id: "x", title: on ? "Hide" : "Show" }];
      const undo = { label: "move objects" };
      const style = { text: "#2962ff", tooltip: "1d" };
      const TYPE_LABEL = { idea: "Idea", fy: ["Annual", "FY"] } as const;
      const PATTERNS = { idea: "Not shown" };
      const a = <Tabs label="Alerts" kind="Not a text field" />;
      const b = <div label="Not a component" />;`,
    ).map((t) => t.text);
    expect(found).toEqual(["Log", "Hide", "Show", "Idea", "Annual", "FY", "Alerts"]);
  });

  it("reads the texts given to translateWith and translateAs", () => {
    const found = staticTexts(
      "x.ts",
      `const a = translateWith("{0} bars", n) + translateAs("Close", "action") + other("Ignored");`,
    ).map((t) => [t.text, t.sense]);
    expect(found).toEqual([["{0} bars", undefined], ["Close", "action"]]);
  });

  it("gives a text the sense of its element or one around it", () => {
    const found = staticTexts(
      "x.tsx",
      `const a = <div data-i18n-sense="action">
        <button title="Close">Post</button>
        <Tip placeholder="Stop" data-i18n-sense="halt" />
      </div>;
      const b = <span>Post</span>;`,
    ).map((t) => [t.text, t.sense]);
    expect(found).toEqual([["Close", "action"], ["Post", "action"], ["Stop", "halt"], ["Post", undefined]]);
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
