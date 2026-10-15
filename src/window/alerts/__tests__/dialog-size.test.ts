import { describe, expect, it } from "vitest";
import { centredBox, fitHeight, keepInWindow, type DialogLimits } from "../dialog-size";

const LIM: DialogLimits = { softMinBody: 170, minBody: null, maxBody: null, guardX: 0, guardY: 0 };

describe("alert dialog height", () => {
  it("keeps header + footer + the body's soft minimum for a short view (name only: 308)", () => {
    // header 71 + footer 67, body 108
    expect(fitHeight(71 + 108 + 67, 71 + 67, LIM, 998)).toBe(308);
  });
  it("takes the content height above the minimum (price alert message view: 508)", () => {
    expect(fitHeight(508, 138, LIM, 998)).toBe(508);
  });
  it("is cut to the window less the guards", () => {
    expect(fitHeight(900, 138, { ...LIM, guardY: 20 }, 700)).toBe(660);
  });
  it("applies the hard minimum / maximum last", () => {
    expect(fitHeight(900, 138, { ...LIM, maxBody: 500 }, 2000)).toBe(638);
    expect(fitHeight(200, 138, { ...LIM, softMinBody: null, minBody: 100 }, 2000)).toBe(238);
  });
});

describe("alert dialog place", () => {
  it("is centred on open", () => {
    expect(centredBox(480, 475, LIM, 1920, 998)).toEqual({ x: 720, y: 261.5, width: 480, height: 475 });
  });
  it("a grown dialog is moved back into the window, top left kept otherwise", () => {
    expect(keepInWindow({ x: 720, y: 400, width: 480, height: 700 }, LIM, 1920, 998)).toEqual({ x: 720, y: 298, width: 480, height: 700 });
    expect(keepInWindow({ x: 720, y: 100, width: 480, height: 500 }, LIM, 1920, 998)).toEqual({ x: 720, y: 100, width: 480, height: 500 });
  });
  it("a dialog taller than the window sits at the top guard", () => {
    expect(keepInWindow({ x: 0, y: 300, width: 480, height: 1200 }, { ...LIM, guardY: 10 }, 1920, 998)).toMatchObject({ y: 10 });
  });
});
