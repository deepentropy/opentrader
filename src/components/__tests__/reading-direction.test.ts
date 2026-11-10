import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  endEdge,
  endSide,
  inlineSign,
  isRtl,
  leftFromStart,
  menuLeftAt,
  physicalSide,
  startAlignedClamped,
  startAlignedLeft,
  startEdge,
  startSide,
} from "../reading-direction";
import { anchorPoint } from "../popover";
import { fitToWindow } from "../menu-fit";

// The node test environment has no DOM: the page is the root element's direction and size.
const root = { dir: "ltr", clientWidth: 1000, clientHeight: 800 };
const g = globalThis as unknown as { document?: unknown };
const saved = g.document;
g.document = { documentElement: root };
afterAll(() => {
  g.document = saved;
});

const box = { left: 100, right: 180 };
const setDir = (dir: "ltr" | "rtl") => {
  root.dir = dir;
};

afterEach(() => setDir("ltr"));

describe("reading direction (#290), left to right: the left-to-right values", () => {
  it("names the sides and edges", () => {
    expect(isRtl()).toBe(false);
    expect([startSide(), endSide(), inlineSign()]).toEqual(["left", "right", 1]);
    expect([startEdge(box), endEdge(box), leftFromStart(100, 40)]).toEqual([100, 180, 100]);
    expect([physicalSide("start"), physicalSide("end"), physicalSide("top")]).toEqual(["left", "right", "top"]);
  });

  it("places a menu at the pointer as before: on the pointer, pushed back at the right edge", () => {
    expect(menuLeftAt(300, 200, 1000, 4)).toBe(300);
    expect(menuLeftAt(900, 200, 1000, 4)).toBe(796);
    expect(menuLeftAt(10, 2000, 1000, 4)).toBe(4);
  });

  it("places a popover under its anchor as before", () => {
    // start aligned, flipped to end aligned at the window's right edge
    expect(startAlignedLeft(box, 50, 1000)).toBe(100);
    expect(startAlignedLeft(box, 50, 1000, 6)).toBe(106);
    expect(startAlignedLeft({ left: 960, right: 990 }, 100, 1000)).toBe(890);
    // start aligned, slid back inside
    expect(startAlignedClamped(box, 250, 1000, 8)).toBe(100);
    expect(startAlignedClamped({ left: 900, right: 930 }, 250, 1000, 8)).toBe(742);
    expect(startAlignedClamped({ left: 2, right: 30 }, 250, 1000, 8)).toBe(8);
  });

  it("keeps the popover anchor points", () => {
    const r = { ...box, top: 40, bottom: 74 };
    expect(anchorPoint(r)).toEqual({ x: 100, y: 74, endX: false, endY: false });
    expect(anchorPoint(r, { align: "end" })).toEqual({ x: 180, y: 74, endX: true, endY: false });
  });
});

describe("reading direction (#290), right to left: mirrored", () => {
  it("names the sides and edges", () => {
    setDir("rtl");
    expect(isRtl()).toBe(true);
    expect([startSide(), endSide(), inlineSign()]).toEqual(["right", "left", -1]);
    expect([startEdge(box), endEdge(box), leftFromStart(100, 40)]).toEqual([180, 100, 60]);
    expect([physicalSide("start"), physicalSide("end"), physicalSide("left")]).toEqual(["right", "left", "left"]);
  });

  it("opens a menu at the pointer toward the left, pushed back at the left edge", () => {
    setDir("rtl");
    expect(menuLeftAt(300, 200, 1000, 4)).toBe(100);
    expect(menuLeftAt(100, 200, 1000, 4)).toBe(4);
    expect(menuLeftAt(10, 2000, 1000, 4)).toBe(-1004);
  });

  it("aligns a popover's right edge with its anchor's", () => {
    setDir("rtl");
    expect(startAlignedLeft(box, 50, 1000)).toBe(130);
    expect(startAlignedLeft(box, 50, 1000, 6)).toBe(124);
    // no room on the left: left edges aligned
    expect(startAlignedLeft({ left: 10, right: 40 }, 100, 1000)).toBe(10);
    expect(startAlignedClamped(box, 50, 1000, 8)).toBe(130);
    expect(startAlignedClamped({ left: 20, right: 60 }, 250, 1000, 8)).toBe(8);
    expect(startAlignedClamped({ left: 990, right: 1000 }, 250, 1000, 8)).toBe(742);
  });

  it("anchors a popover by the start and end edges of the reading direction", () => {
    setDir("rtl");
    const r = { ...box, top: 40, bottom: 74 };
    expect(anchorPoint(r)).toEqual({ x: 180, y: 74, endX: false, endY: false });
    expect(anchorPoint(r, { align: "end" })).toEqual({ x: 100, y: 74, endX: true, endY: false });
  });
});

describe("fitToWindow (#290)", () => {
  // A menu element of the given size.
  const menu = (width: number, height: number) =>
    ({ style: {} as Record<string, string>, getBoundingClientRect: () => ({ width, height }) }) as unknown as HTMLElement;
  const size = (w: number, h: number) => {
    root.clientWidth = w;
    root.clientHeight = h;
  };

  it("left to right: the point is the menu's top-left (its top-right with endX)", () => {
    size(1000, 800);
    const el = menu(200, 100);
    fitToWindow(el, 300, 50);
    expect([el.style.left, el.style.top]).toEqual(["300px", "50px"]);
    fitToWindow(el, 300, 50, true);
    expect(el.style.left).toBe("100px");
  });

  it("right to left: the point is the menu's top-right (its top-left with endX)", () => {
    setDir("rtl");
    size(1000, 800);
    const el = menu(200, 100);
    fitToWindow(el, 300, 50);
    expect(el.style.left).toBe("100px");
    fitToWindow(el, 300, 50, true);
    expect(el.style.left).toBe("300px");
    // kept inside the window
    fitToWindow(el, 120, 50);
    expect(el.style.left).toBe("0px");
  });
});
