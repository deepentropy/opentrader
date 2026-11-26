import { afterEach, describe, expect, it, vi } from "vitest";
import { clampPointer, moverOf } from "../dialog-drag";

describe("dialog drag pointer (#185)", () => {
  it("stays 20 px inside the window", () => {
    expect(clampPointer(-3000, -3000, 1920, 998)).toEqual({ x: 20, y: 20 });
    expect(clampPointer(5000, 5000, 1920, 998)).toEqual({ x: 1900, y: 978 });
    expect(clampPointer(700, 400, 1920, 998)).toEqual({ x: 700, y: 400 });
  });
});

describe("a moved dialog is never transformed (#416)", () => {
  // The computed style is the dialog's own, as its stylesheet would give it.
  const dialog = (css: Partial<CSSStyleDeclaration>) => {
    const el = { style: {} as Record<string, string> } as unknown as HTMLElement;
    vi.stubGlobal("getComputedStyle", () => ({ position: "static", left: "auto", top: "auto", marginLeft: "0px", marginTop: "0px", ...css }));
    return el;
  };
  afterEach(() => { vi.unstubAllGlobals(); });

  it("moves a dialog in the flow by left/top", () => {
    const el = dialog({});
    moverOf(el)(30, -12);
    expect(el.style.position).toBe("relative");
    expect([el.style.left, el.style.top]).toEqual(["30px", "-12px"]);
    expect(el.style.translate ?? el.style.transform).toBeUndefined();
  });

  it("adds to a relative dialog's own offset", () => {
    const el = dialog({ position: "relative", left: "5px", top: "7px" });
    moverOf(el)(10, 10);
    expect([el.style.left, el.style.top]).toEqual(["15px", "17px"]);
  });

  it("moves a fixed dialog by its margins, its left/top left to the code that placed it", () => {
    const el = dialog({ position: "fixed", left: "100px", top: "50px", marginTop: "4px" });
    const move = moverOf(el);
    move(20, 30);
    move(-5, 6);
    expect(el.style.left ?? "").toBe("");
    expect([el.style.marginLeft, el.style.marginTop]).toEqual(["-5px", "10px"]);
    expect(el.style.translate ?? el.style.transform).toBeUndefined();
  });
});
