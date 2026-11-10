import { afterEach, describe, expect, it } from "vitest";
import { inEnglish, lookUp, setDictionary, translate, translateAs, translateDrawn, translatePlural, translateWith } from "../translator";
import { languageEntry } from "../languages";
import { libraryMonthRule } from "../format";
import zhHans from "../zh-Hans.json";

const D = { Save: "保存", "Open…": "打开…" };
const ZH = languageEntry("zh-Hans")!;

afterEach(() => setDictionary({}));

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
  });
  it("translateDrawn: each line; a library's month name in the language's", () => {
    setDictionary({ Strong: "强烈", Buy: "买入" }, [libraryMonthRule(ZH.formats.dateLocale)]);
    expect(translateDrawn("Strong\nBuy")).toBe("强烈\n买入");
    expect(translateDrawn("Jan")).toBe("1月");
    expect(translateDrawn("HH")).toBe("HH");
    setDictionary({});
    expect(translateDrawn("Buy")).toBe("Buy");
  });
});

describe("counted text (#288)", () => {
  const BARS = { one: "{0} bar", other: "{0} bars" };
  it("English: one and other, by the English rules", () => {
    expect(translatePlural(1, BARS)).toBe("1 bar");
    expect(translatePlural(0, BARS)).toBe("0 bars");
    expect(translatePlural(2, BARS)).toBe("2 bars");
    expect(translatePlural(1, { one: "Delete {0} and its {1} trade?", other: "Delete {0} and its {1} trades?" }, "J", 1)).toBe("Delete J and its 1 trade?");
    expect(translatePlural(1250, BARS, "1,250")).toBe("1,250 bars");
  });
  it("a language with one form: one text for every count", () => {
    setDictionary({ "{0} bars": "{0} 根K线" }, [], "zh");
    expect(translatePlural(1, BARS)).toBe("1 根K线");
    expect(translatePlural(5, BARS)).toBe("5 根K线");
  });
  it("a language with several forms: the form of its category, other when it has none", () => {
    setDictionary({ "{0} bars": { one: "{0} barre", many: "{0} de barres", other: "{0} barres" } }, [], "fr");
    expect(translatePlural(1, BARS)).toBe("1 barre");
    expect(translatePlural(0, BARS)).toBe("0 barre");
    expect(translatePlural(2, BARS)).toBe("2 barres");
    expect(translatePlural(1_000_000, BARS)).toBe("1000000 de barres");
    setDictionary({ "{0} bars": { one: "{0} ряд", few: "{0} ряда", other: "{0} рядов" } }, [], "ru");
    expect(translatePlural(3, BARS)).toBe("3 ряда");
    expect(translatePlural(5, BARS)).toBe("5 рядов");
  });
  it("the page reads a counted entry by its other form", () => {
    expect(translate("{0} bars", { "{0} bars": { one: "{0} barre", other: "{0} barres" } })).toBe("{0} barres");
  });
  it("Chinese has the dictionary's forms", () => {
    setDictionary(zhHans, [], "zh");
    expect(translatePlural(1, { one: "{0} drawing", other: "{0} drawings" })).toBe("1 个绘图");
  });
});
