import { describe, expect, it } from "vitest";
import { translate } from "../translator";

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
