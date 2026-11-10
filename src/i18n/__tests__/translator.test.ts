import { describe, expect, it } from "vitest";
import { inEnglish, lookUp, setDictionary, translate, translateAs, translateDrawn, translateWith } from "../translator";
import zhHans from "../zh-Hans.json";
import zhHant from "../zh-Hant.json";
import { SIMPLIFIED_RULES, TRADITIONAL_RULES } from "../zh-patterns";

const D = { Save: "保存", "Open…": "打开…" };

describe("translate (#189)", () => {
  it("finds the text, keeps its spaces", () => {
    expect(translate("Save", D)).toBe("保存");
    expect(translate("  Save ", D)).toBe("  保存 ");
  });
  it("keeps the text it doesn't know, and numbers", () => {
    expect(translate("AAPL", D)).toBe("AAPL");
    expect(translate("344.63", D)).toBe("344.63");
    expect(translate("", D)).toBe("");
  });
  it("adds an ending the dictionary has without it", () => {
    expect(translate("Save…", D)).toBe("保存…");
    expect(translate("Save...", D)).toBe("保存...");
    expect(translate("Save:", D)).toBe("保存:");
    expect(translate("Open…", D)).toBe("打开…");
  });
});

describe("a word with two meanings (#285)", () => {
  const W = { Post: "盘后", "Post|action": "发布", Close: "收盘" };
  it("looks up the sense's own entry first", () => {
    expect(lookUp("Post", W, "action")).toBe("发布");
    expect(translate(" Post ", W, "action")).toBe(" 发布 ");
    expect(translate("Post…", W, "action")).toBe("发布…");
  });
  it("the word's entry without a sense, or when the sense has none", () => {
    expect(translate("Post", W)).toBe("盘后");
    expect(translate("Close", W, "action")).toBe("收盘");
    expect(lookUp("Pre", W, "action")).toBeUndefined();
  });
  it("translateAs: the page's dictionary in a sense, English without one", () => {
    setDictionary(W);
    expect(translateAs("Post", "action")).toBe("发布");
    expect(translate("Post")).toBe("盘后");
    setDictionary({});
    expect(translateAs("Post", "action")).toBe("Post");
  });
});

describe("text holding a value (#190)", () => {
  it("dates and sentences, in both scripts", () => {
    setDictionary({ Save: "保存" }, SIMPLIFIED_RULES);
    expect(translate("Mon 26 Oct '26")).toBe("2026年10月26日 周一");
    expect(translate("Mon 26 Oct '26   14:30")).toBe("2026年10月26日 周一   14:30");
    expect(translate("Sep 10, 2003 — Oct 30, 2026")).toBe("2003年9月10日 — 2026年10月30日");
    expect(translate("November 2026")).toBe("2026年11月");
    expect(translate("Oct")).toBe("10月");
    expect(translate("Last update at 01:00 UTC+1")).toBe("最后更新于 01:00 UTC+1");
    expect(translate("440 USD left to cover")).toBe("尚需 440 USD");
    expect(translate("3 drawings")).toBe("3 个绘图");
    expect(translate("AAPL")).toBe("AAPL");
    expect(translate("Save")).toBe("保存");
    setDictionary({}, TRADITIONAL_RULES);
    expect(translate("Tue 27 Oct '26")).toBe("2026年10月27日 週二");
    setDictionary({});
  });
});

describe("text with values from the code (#190)", () => {
  it("translateWith: the template's translation with the values", () => {
    setDictionary({ "{0} bars": "{0} 根K线", "{0} on {1}": "{1} 上的 {0}" });
    expect(translateWith("{0} bars", 12)).toBe("12 根K线");
    expect(translateWith("{0} on {1}", "MA 9", "AAPL")).toBe("AAPL 上的 MA 9");
    expect(translateWith("{0} left {1}", "AAPL", "Oversold")).toBe("AAPL left Oversold");
    // Message placeholders are not values.
    expect(translateWith("{0}: {{ticker}}", "S")).toBe("S: {{ticker}}");
    setDictionary({});
    expect(translateWith("{0} bars", 3)).toBe("3 bars");
  });
  it("inEnglish: the English text inside, the language after", () => {
    setDictionary({ "{0} bars": "{0} 根K线" });
    expect(inEnglish(() => translateWith("{0} bars", 2))).toBe("2 bars");
    expect(translateWith("{0} bars", 2)).toBe("2 根K线");
    setDictionary({});
  });
  it("translateDrawn: each line", () => {
    setDictionary({ Strong: "强烈", Buy: "买入" }, SIMPLIFIED_RULES);
    expect(translateDrawn("Strong\nBuy")).toBe("强烈\n买入");
    expect(translateDrawn("Jan")).toBe("1月");
    expect(translateDrawn("HH")).toBe("HH");
    setDictionary({});
    expect(translateDrawn("Buy")).toBe("Buy");
  });
});

describe("the dictionaries (#190)", () => {
  for (const [name, d] of [["zh-Hans", zhHans], ["zh-Hant", zhHant]] as const) {
    it(`${name}: every translation of a template keeps its values`, () => {
      const holes = (s: string) => (s.match(/\{\d+\}|\{\{[^}]+\}\}/g) ?? []).sort().join(" ");
      const wrong = Object.entries(d as Record<string, string>).filter(([en, to]) => holes(en) !== holes(to)).map(([en]) => en);
      expect(wrong).toEqual([]);
    });
  }
  it("every sense is the sense of a word the dictionary has", () => {
    // "Post|action"; a text holding a bar ("DMSDB | MisinkoMaster") is not a sense.
    const orphans = Object.keys(zhHans).filter((k) => /^[^|]+\|[a-z]+$/.test(k) && !(k.slice(0, k.indexOf("|")) in zhHans));
    expect(orphans).toEqual([]);
  });
  it("both scripts have the same texts", () => {
    expect(Object.keys(zhHant).filter((k) => !(k in zhHans))).toEqual([]);
    expect(Object.keys(zhHans).filter((k) => !(k in zhHant))).toEqual([]);
  });
});
