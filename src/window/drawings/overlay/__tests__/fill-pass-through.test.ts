// #344: a mouse press on a drawing's fill goes to the chart (pan), as in the reference app: an unselected fill
// takes no hover, selection, drag, middle click or menu from a mouse; the outline and handles do. A selected
// rectangle, circle or ellipse is grabbed by its fill. A touch on a fill still selects the drawing.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, createSignal } from "solid-js";
import type { Coords } from "lightweight-charts-drawing/core/coords";
import type { Drawing } from "lightweight-charts-drawing/core/types";
import { defaultStyleFor } from "lightweight-charts-drawing/core/specs";
import { createSelection, type SelectionApi } from "../selection";
import type { Frame, OverlayCx } from "../context";

const W = 800;
const H = 500;
/** Time t at x = t, price p at y = H - p. */
const coords = {
  priceToY: (p: number) => H - p,
  yToPrice: (y: number) => H - y,
  isLog: () => false,
  timeToX: (t: number) => t,
  xToTime: (x: number) => x,
  barAt: () => null,
  timeToBarIndex: (t: number) => t,
  barIndexToTime: (i: number) => i,
  bars: () => [],
  timeAxis: () => ({ height: 28, width: W, fontSize: 12, fontFamily: "sans-serif" }),
  timeInfo: () => ({ timeZone: "UTC", intraday: false }),
  formatTime: () => "",
  pipSize: () => 0.01,
  visibleTimeRange: () => ({ from: 0, to: W }),
  indicatorValuesAt: () => [],
} as unknown as Coords;
const frame: Frame = { key: null, top: 0, dims: { w: W, h: H }, coords, clip: "c" };

/** A filled rectangle with its corners at pixels (100, 100) and (300, 300). */
const rect = {
  id: "rect",
  kind: "rectangle",
  points: [{ time: 100, price: H - 100 }, { time: 300, price: H - 300 }],
  style: { ...defaultStyleFor("rectangle") },
} as unknown as Drawing;

const INSIDE = { x: 200, y: 220 };
const BORDER = { x: 150, y: 100.5 };

let dispose: (() => void) | null = null;
afterEach(() => {
  dispose?.();
  dispose = null;
  vi.unstubAllGlobals();
});

/** Fake events: what the handlers read, with spied stopPropagation / preventDefault. */
type FakeEvent = { clientX: number; clientY: number; button: number; buttons: number; pointerType: string; target: unknown; ctrlKey: boolean; metaKey: boolean; defaultPrevented: boolean; stopPropagation: () => void; preventDefault: () => void };
function ev(at: { x: number; y: number }, pointerType = "mouse", init: Partial<FakeEvent> = {}): FakeEvent {
  const e: FakeEvent = {
    clientX: at.x, clientY: at.y, button: 0, buttons: 0, pointerType, target: null, ctrlKey: false, metaKey: false, defaultPrevented: false,
    stopPropagation: vi.fn(),
    preventDefault: () => { e.defaultPrevented = true; },
    ...init,
  };
  return e;
}
const down = (at: { x: number; y: number }, pointerType = "mouse", button = 0) => ev(at, pointerType, { button }) as unknown as PointerEvent;

function setup(selected: string[] = []) {
  // The window's pointermove listener of the pass-through, called by the tests.
  const moves: ((e: PointerEvent) => void)[] = [];
  vi.stubGlobal("window", {
    addEventListener: (type: string, fn: (e: PointerEvent) => void) => { if (type === "pointermove") moves.push(fn); },
    removeEventListener: () => {},
  });
  vi.stubGlobal("document", { addEventListener: () => {}, removeEventListener: () => {} });
  const painted = { name: "painted" };
  const svg = {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: W, height: H }),
    contains: (n: unknown) => n === painted || n === svg,
  };
  const [drag, setDrag] = createSignal<unknown>(null);
  const props = {
    drawings: [rect],
    selectedIds: selected,
    selectedId: selected[0] ?? null,
    setSelectedId: vi.fn(),
    onRemove: vi.fn(),
    onUpdate: vi.fn(),
    onToggleSelect: vi.fn(),
    onClone: vi.fn(),
  };
  const cx = {
    props,
    armedSpec: () => null,
    cmode: () => "cross",
    drag,
    setDrag,
    intervalHidden: () => false,
    notShown: () => false,
    setCursor: vi.fn(),
    setMenu: vi.fn(),
    shiftDown: () => false,
    drawFrame: () => frame,
    toLocal: (p: { x: number; y: number }, f: Frame) => ({ x: p.x, y: p.y - f.top }),
    size: () => ({ w: W, h: H }),
    svg,
  } as unknown as OverlayCx;
  let api!: SelectionApi;
  createRoot((d) => {
    dispose = d;
    api = createSelection(cx);
  });
  const move = (target: unknown, at: { x: number; y: number }, init: Partial<FakeEvent> = {}, pointerType = "mouse") =>
    moves.forEach((fn) => fn(ev(at, pointerType, { target, ...init }) as unknown as PointerEvent));
  return { api, props, cx, painted, move };
}

describe("hit test (#344)", () => {
  it("a fill hits only for touch; the outline hits for both", () => {
    const { api } = setup();
    expect(api.hitTopmost(INSIDE)).toBeNull();
    expect(api.hitTopmost(INSIDE, true)?.mode).toEqual({ hit: "body", background: true });
    expect(api.hitTopmost(BORDER)?.mode).toEqual({ hit: "body" });
  });
});

describe("mouse press on a fill (#344)", () => {
  it("does not select nor take the press: the chart pans", () => {
    const { api, props } = setup();
    const e = down(INSIDE);
    api.onSelectionPointerDown(e);
    expect(e.stopPropagation).not.toHaveBeenCalled();
    expect(props.setSelectedId).toHaveBeenCalledWith(null);
  });

  it("a selected rectangle is grabbed by its fill: it stays selected and drags", () => {
    const { api, props, cx } = setup(["rect"]);
    const e = down(INSIDE);
    api.onSelectionPointerDown(e);
    expect(e.stopPropagation).toHaveBeenCalled();
    expect((cx.drag() as { id: string } | null)?.id).toBe("rect");
    expect(props.setSelectedId).not.toHaveBeenCalled();
  });

  it("a selected triangle keeps a pass-through fill", () => {
    const tri = { id: "tri", kind: "triangle", points: [{ time: 100, price: H - 400 }, { time: 300, price: H - 100 }, { time: 500, price: H - 400 }], style: { ...defaultStyleFor("triangle") } } as unknown as Drawing;
    const { api, props } = setup(["tri"]);
    props.drawings = [tri];
    expect(api.hitTopmost({ x: 300, y: 300 })).toBeNull();
    expect(api.hitTopmost({ x: 300, y: 300 }, true)?.mode).toEqual({ hit: "body", background: true });
  });

  it("middle click and right click on a fill leave the drawing alone", () => {
    const { api, props, cx } = setup();
    api.onSelectionPointerDown(down(INSIDE, "mouse", 1));
    expect(props.onRemove).not.toHaveBeenCalled();
    const menu = ev(INSIDE);
    api.onContextMenu(menu as unknown as MouseEvent);
    expect(menu.defaultPrevented).toBe(false);
    expect(cx.setMenu).not.toHaveBeenCalled();
    api.onContextMenu(ev(BORDER) as unknown as MouseEvent);
    expect(cx.setMenu).toHaveBeenCalled();
  });

  it("a touch on a fill selects the drawing", () => {
    const { api, props } = setup();
    const e = down(INSIDE, "touch");
    api.onSelectionPointerDown(e);
    expect(e.stopPropagation).toHaveBeenCalled();
    expect(props.setSelectedId).toHaveBeenCalledWith("rect");
    expect(api.touchPress()).toBe(true);
  });
});

describe("pass-through on hover (#344)", () => {
  const chart = { name: "chart canvas" };

  it("over a fill the drawings let the pointer through; over the outline they take it back", () => {
    const { api, painted, move } = setup();
    expect(api.fillPassThrough()).toBe(false);
    move(painted, INSIDE);
    expect(api.fillPassThrough()).toBe(true);
    // Now the press lands on the chart: the overlay checks the moves there too.
    move(chart, BORDER);
    expect(api.fillPassThrough()).toBe(false);
  });

  it("a held button (a pan in progress) and touch leave it as it is", () => {
    const { api, painted, move } = setup();
    move(painted, INSIDE);
    move(chart, BORDER, { buttons: 1 });
    expect(api.fillPassThrough()).toBe(true);
    move(chart, BORDER, {}, "touch");
    expect(api.fillPassThrough()).toBe(true);
  });

  it("over a selected rectangle's fill the drawings keep the pointer", () => {
    const { api, painted, move } = setup(["rect"]);
    move(painted, INSIDE);
    expect(api.fillPassThrough()).toBe(false);
  });

  it("moves elsewhere on the page are not hit-tested", () => {
    const { api, move } = setup();
    move(chart, INSIDE);
    expect(api.fillPassThrough()).toBe(false);
  });
});
