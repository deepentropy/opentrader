import { describe, expect, it } from "vitest";
import { settingsUndoText } from "../settings-undo-text";
import { defaultIndicatorOptions } from "../indicator-options";

const base = { inputs: { length: 20 }, styles: { vol: { visible: true, color: "#26A69A" } }, options: defaultIndicatorOptions() };
const inputs = [{ id: "length", title: "MA Length" }];

describe("undo text of a Settings dialog change (the reference app's texts)", () => {
  it("names the input that changed", () => {
    expect(settingsUndoText(base, { ...base, inputs: { length: 25 } }, inputs, "Vol")).toEqual({ key: "input:length", label: "change MA Length property" });
  });
  it("names the plot field that changed", () => {
    const style = (o: object) => ({ ...base, styles: { vol: { ...base.styles.vol, ...o } } });
    expect(settingsUndoText(base, style({ visible: false }), inputs, "Vol").label).toBe("change visibility");
    expect(settingsUndoText(base, style({ color: "#000000" }), inputs, "Vol").label).toBe("change color");
    expect(settingsUndoText(base, style({ lineWidth: 3 }), inputs, "Vol").label).toBe("change thickness");
    expect(settingsUndoText(base, style({ plotType: "histogram" }), inputs, "Vol").label).toBe("change plot type");
    expect(settingsUndoText(base, style({ priceLine: true }), inputs, "Vol").label).toBe("change price line visibility");
    expect(settingsUndoText(base, style({ shape: "circle" }), inputs, "Vol").label).toBe("change Vol style");
  });
  it("names the precision and the values in the status line", () => {
    expect(settingsUndoText(base, { ...base, options: { ...base.options, precision: "2" } }, inputs, "Vol").label).toBe("change precision");
    expect(settingsUndoText(base, { ...base, options: { ...base.options, valuesInStatusLine: !base.options.valuesInStatusLine } }, inputs, "Vol").label).toBe("change values visibility");
  });
});
