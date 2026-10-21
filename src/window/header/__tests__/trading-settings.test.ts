import { describe, expect, it } from "vitest";
import { makeDefaultDraft, reviveDraft, SETTINGS_FINGERPRINT, tradingAppearance } from "../chart-settings";

describe("Chart settings → Trading", () => {
  it("factory values of the reference app", () => {
    expect(tradingAppearance(undefined)).toEqual({
      buySellButtons: true,
      oneClick: false,
      sound: null,
      rejectionOnly: false,
      positions: true,
      reverseButton: true,
      plPositions: "money",
      plBrackets: "money",
      executions: true,
      executionLabels: false,
      extendLines: true,
      align: "right",
    });
  });

  it("reads the rows (children off with their parent)", () => {
    const d = makeDefaultDraft();
    d["trading:Execution sound"].checked = true;
    d["trading:Execution sound"].controls[0] = { kind: "slider", value: 30 };
    d["trading:Execution sound type"].controls[0] = { kind: "select", value: "Beep-beep" };
    d["trading:Profit and loss value"].checked = false;
    d["trading:Positions and orders"].checked = false;
    d["trading:Execution labels"].checked = true;
    d["trading:Order and position alignment"].controls[0] = { kind: "select", value: "Left" };
    const t = tradingAppearance(d);
    expect(t.sound).toEqual({ key: "beep_beep", volume: 0.3 });
    expect(t.plPositions).toBeNull();
    expect(t.plBrackets).toBeNull();
    expect(t.positions).toBe(false);
    expect(t.reverseButton).toBe(false);
    expect(t.executionLabels).toBe(true);
    expect(t.align).toBe("left");
  });

  it("drafts saved while the rows were inert (rev < 7) take the factory values", () => {
    const old = makeDefaultDraft();
    old["trading:Positions and orders"].checked = false;
    old["trading:Buy/sell buttons"].checked = false;
    old["legend:Buy/sell buttons"].checked = false;
    old["canvas:Vertical grid lines"].checked = false;
    const back = reviveDraft(JSON.parse(JSON.stringify(old)), SETTINGS_FINGERPRINT, 6)!;
    expect(back["trading:Positions and orders"].checked).toBe(true);
    expect(back["trading:Buy/sell buttons"].checked).toBe(true);
    expect(back["legend:Buy/sell buttons"].checked).toBe(true);
    // Other rows keep their saved values.
    expect(back["canvas:Vertical grid lines"].checked).toBe(false);
  });
});
