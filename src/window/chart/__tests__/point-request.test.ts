import { describe, expect, it } from "vitest";
import { askPoints, canPickOn, cancelPointRequest, pointRequest, pointSteps, setPickable, type PointInput } from "../point-request";

const t = (id: string, extra: Partial<PointInput> = {}): PointInput => ({ id, type: "time", ...extra });
const p = (id: string, extra: Partial<PointInput> = {}): PointInput => ({ id, type: "price", ...extra });

describe("point steps (reference rules)", () => {
  it("a time and a price alone on an inline row are one point", () => {
    const inputs = [t("t1", { inline: "Entry" }), p("p1", { inline: "Entry" })];
    expect(pointSteps(inputs, inputs, "Trade")).toEqual([
      { kind: "all", hint: 'Set the "Entry" time and price for "Trade"', timeId: "t1", priceId: "p1" },
    ]);
  });

  it("other inputs are one point each, in their order, with their title", () => {
    const inputs = [p("p1", { title: "Level" }), t("t1"), t("t2", { title: "Start" })];
    expect(pointSteps(inputs, inputs, "S").map((s) => [s.kind, s.hint])).toEqual([
      ["price", 'Set the "Level" price for "S"'],
      ["time", 'Set the time for "S"'],
      ["time", 'Set the "Start" time for "S"'],
    ]);
  });

  it("three inputs on one row, or two of one kind, are not a pair", () => {
    const three = [t("a", { inline: "r" }), p("b", { inline: "r" }), p("c", { inline: "r" })];
    expect(pointSteps(three, three, "S").map((s) => s.kind)).toEqual(["time", "price", "price"]);
    const two = [t("a", { inline: "r" }), t("b", { inline: "r" })];
    expect(pointSteps(two, two, "S").map((s) => s.kind)).toEqual(["time", "time"]);
  });

  it("the same inline id in two groups is two rows", () => {
    const inputs = [t("a", { inline: "r", group: "G1" }), p("b", { inline: "r", group: "G2" })];
    expect(pointSteps(inputs, inputs, "S").map((s) => s.kind)).toEqual(["time", "price"]);
  });

  it("the hint is the inline row's tooltip (any input of the row), else the input's tooltip", () => {
    const all = [t("t1", { inline: "E" }), p("p1", { inline: "E" }), { id: "n", type: "int", inline: "E", tooltip: "Click the entry" }];
    expect(pointSteps(all.slice(0, 2), all, "S")[0].hint).toBe("Click the entry");
    const one = [p("p1", { tooltip: "Pick the level" })];
    expect(pointSteps(one, one, "S")[0].hint).toBe("Pick the level");
  });
});

describe("asking points", () => {
  it("gives times in milliseconds and prices as clicked; cancel gives null", async () => {
    const target = { tabId: "tab", paneIndex: 0 };
    const steps = pointSteps([t("t1", { inline: "E" }), p("p1", { inline: "E" }), p("p2")], [], "S");
    const run = askPoints(target, steps);
    await Promise.resolve();
    expect(pointRequest()?.kind).toBe("all");
    pointRequest()!.resolve({ time: 1_700_000_000, price: 101.5 });
    await Promise.resolve();
    await Promise.resolve();
    expect(pointRequest()?.kind).toBe("price");
    expect(pointRequest()?.picked).toEqual([{ time: 1_700_000_000, price: 101.5 }]);
    pointRequest()!.resolve({ price: 99.25 });
    expect(await run).toEqual({ t1: 1_700_000_000_000, p1: 101.5, p2: 99.25 });
    expect(pointRequest()).toBeNull();

    const cancelled = askPoints(target, steps);
    await Promise.resolve();
    cancelPointRequest();
    expect(await cancelled).toBeNull();
  });

  it("knows which charts can take a point", () => {
    const target = { tabId: "x", paneIndex: 1 };
    expect(canPickOn(target)).toBe(false);
    setPickable(target, true);
    expect(canPickOn(target)).toBe(true);
    setPickable(target, false);
    expect(canPickOn(target)).toBe(false);
  });
});
