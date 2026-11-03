import { describe, expect, it, vi } from "vitest";

// The engine (delivery) and the screener backend are not needed for the diff rules.
vi.mock("../alert-engine", () => ({ deliverScreenFire: () => {} }));
vi.mock("../screener-api", () => ({}));

import { MAX_SINGLE, screenChanges, screenFires } from "../screen-alerts";
import { defaultAlertMessage, describeCondition } from "../alert-condition";
import { isScreenRule, type AlertRule } from "../alert-store";

describe("screen alerts", () => {
  it("finds the symbols that entered and left", () => {
    expect(screenChanges(new Set(["A", "B", "C"]), new Set(["B", "C", "E", "D"]))).toEqual({ entered: ["D", "E"], left: ["A"] });
    expect(screenChanges(new Set(), new Set())).toEqual({ entered: [], left: [] });
  });

  it("fires one alert per symbol, or one for all of them past the limit", () => {
    expect(screenFires([])).toEqual([]);
    expect(screenFires(["A", "B"])).toEqual([["A"], ["B"]]);
    const many = Array.from({ length: MAX_SINGLE + 1 }, (_, i) => `T${i}`);
    expect(screenFires(many)).toEqual([many]);
  });

  it("names the condition and the message of a fire", () => {
    const rule = {
      symbol: "NASDAQ:AAPL",
      resolution: "",
      left: { kind: "screen", screenId: "s1", title: "Oversold" },
      op: "screen_enter",
      right: { kind: "value", value: 0 },
    } as Pick<AlertRule, "symbol" | "resolution" | "left" | "op" | "right" | "bars">;
    expect(isScreenRule(rule)).toBe(true);
    expect(describeCondition(rule)).toBe("Oversold: A symbol enters the screen");
    expect(defaultAlertMessage(rule)).toBe("AAPL entered Oversold");
    expect(defaultAlertMessage({ ...rule, op: "screen_exit" })).toBe("AAPL left Oversold");
  });
});
