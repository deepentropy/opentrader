import { describe, expect, it } from "vitest";
import { setDictionary, translate } from "../translator";
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
