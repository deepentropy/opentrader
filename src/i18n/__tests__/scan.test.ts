import { describe, expect, it } from "vitest";
import { translatable, translate } from "../translator";
import { joinedTexts, staticTexts } from "../tools/scan";

const texts = (file: string, source: string) => staticTexts(file, source).map((t) => t.text);

describe("the interface text written in the code", () => {
  it("reads JSX text and the title / placeholder attributes", () => {
    const found = texts(
      "x.tsx",
      `const a = <div title="Close menu" placeholder={"Search"} class="not-text" aria-label="Not translated">
        Save
        layout <b>{n}</b> &gt; more
      </div>;`,
    );
    expect(found).toEqual(["Close menu", "Search", "Save layout", "> more"]);
  });

  it("reads the strings a JSX expression shows, not those it compares or passes", () => {
    const found = texts(
      "x.tsx",
      `const a = <div title={busy ? "Saving" : "Save"}>
        {kind === "log" ? "No events yet" : "No alerts yet"}
        {n > 0 && "Matches"}{name ?? "Unnamed"}{("Plain")}
        {label("Not shown as is")}{rows.map((r) => r.id)}
        <span class={on ? "is-on" : "is-off"} />
      </div>;`,
    );
    expect(found).toEqual(["Saving", "Save", "No events yet", "No alerts yet", "Matches", "Unnamed", "Plain"]);
  });

  it("reads the text fields of objects and the text props and options of components", () => {
    const found = texts(
      "x.tsx",
      `const TABS = [{ id: "log", label: "Log", value: "Value" }, { id: "x", title: on ? "Hide" : "Show" }];
      const undo = { label: "move objects" };
      const style = { text: "#2962ff", tooltip: "1d" };
      const TYPE_LABEL = { idea: "Idea", fy: ["Annual", "FY"] } as const;
      const PATTERNS = { idea: "Not shown" };
      const symbol = { ticker: "AAPL", description: "Apple Inc." };
      const screen = { id: "1", description: "Largest companies" };
      const a = <Tabs label="Alerts" kind="Not a text field" options={["Values", "Percents"]} />;
      const b = <div label="Not a component" />;`,
    );
    expect(found).toEqual(["Log", "Hide", "Show", "Idea", "Annual", "FY", "Largest companies", "Alerts", "Values", "Percents"]);
  });

  it("reads what a variable or function named for a text holds, and the text arguments of the file's functions", () => {
    const found = texts(
      "x.ts",
      `const menuTitle = kind === "lock" ? "Lock options" : "Hide options";
      const tip = () => (dirty ? "Save all" : "All saved");
      function statusText(on: boolean) { if (on) return "Active"; return "Inactive"; }
      const context = on ? "Not a text" : "Nor this";
      function popular(id: string, title: string) { return { id, title }; }
      popular("14", "All stocks");`,
    );
    expect(found).toEqual(["Lock options", "Hide options", "Save all", "All saved", "Active", "Inactive", "All stocks"]);
  });

  it("reads the texts given to the translator, with their sense and plural forms", () => {
    const found = staticTexts(
      "x.ts",
      `const a = translateWith(on ? "{0} on" : "{0} off", n) + translateAs("Close", "action") + translate("High") + other("Ignored");
      const b = translatePlural(n, { one: "{0} bar", other: "{0} bars" });`,
    ).map((t) => [t.text, t.sense, t.plural]);
    expect(found).toEqual([
      ["{0} on", undefined, undefined],
      ["{0} off", undefined, undefined],
      ["Close", "action", undefined],
      ["High", undefined, undefined],
      ["{0} bars", undefined, { one: "{0} bar", other: "{0} bars" }],
    ]);
  });

  it("reads a text written in pieces for the line length as one", () => {
    expect(texts("x.ts", `const n = { text: "A long " + "sentence." };`)).toEqual(["A long sentence."]);
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
});

describe("text joined from pieces (#288)", () => {
  const joined = (source: string) => joinedTexts("x.tsx", source).map((j) => j.code);

  it("finds words joined to values where text is shown", () => {
    expect(
      joined(
        `const a = <div title={"Undo " + step}>{\`\${n} decimals\`}</div>;
        const row = { label: on ? \`Add \${sym} to watchlist\` : "None" };
        const tip = () => \`Exit\${pct}\`;`,
      ),
    ).toEqual(['"Undo " + step', "`${n} decimals`", "`Add ${sym} to watchlist`", "`Exit${pct}`"]);
  });

  it("lets values, symbols, abbreviations and ids be joined", () => {
    expect(
      joined(
        `const a = <div title={\`\${a} · \${b}\`}>{\`\${n}%\`}{\`\${mb} MB\`}{"A long " + "sentence."}</div>;
        const label = \`chart-\${seq}\`;
        const text = \`UTC\${sign}\${h}\`;
        const x = { label: translateWith("Undo {0}", step) };`,
      ),
    ).toEqual([]);
  });
});
