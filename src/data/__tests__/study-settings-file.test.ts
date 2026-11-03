import { describe, expect, it } from "vitest";
import { matchInputs, parseSettingsFile, settingsFile, settingsFileName } from "../study-settings-file";

describe("study settings file", () => {
  it("round-trips a study's values", () => {
    const f = settingsFile("RSI", { inputs: { length: 21, src: "close" }, styles: { plot0: { color: "#f00" } }, options: { precision: 2 } });
    const back = parseSettingsFile(JSON.stringify(f));
    expect(back).toMatchObject({ study: "RSI", inputs: { length: 21, src: "close" }, styles: { plot0: { color: "#f00" } } });
    expect(settingsFileName("A/B: test")).toBe("A_B_ test settings.json");
  });
  it("refuses other files", () => {
    expect(() => parseSettingsFile("not json")).toThrow("not a settings file");
    expect(() => parseSettingsFile(JSON.stringify({ format: "x", inputs: {} }))).toThrow("not a settings file");
    expect(() => parseSettingsFile(JSON.stringify({ format: "opentrader-study-settings", version: 9, inputs: {} }))).toThrow("newer version");
  });
  it("keeps the inputs the script still has, with the same type", () => {
    const config = [
      { id: "length", title: "Length", defval: 14 },
      { id: "src", title: "Source", defval: "close" },
    ];
    const r = matchInputs(config, { length: "21", src: "hl2", gone: 3, __properties: {} });
    expect(r.inputs).toEqual({ src: "hl2" });
    expect(r.skipped).toEqual(["Length", "gone"]);
  });
});
