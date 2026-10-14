import { describe, expect, it } from "vitest";
import { moveItem, paneItems, splitItems, type TreeItem } from "../tree-order";

const ids = (items: TreeItem[]) => items.map((x) => `${x.kind[0]}:${x.id}`);

describe("paneItems", () => {
  it("places each drawing right in front of its source, the rest behind all sources", () => {
    const items = paneItems(["main", "rsi"], [
      { id: "d1", over: "rsi" },
      { id: "d2" },
      { id: "d3", over: "main" },
      { id: "d4", over: "gone" },
    ]);
    expect(ids(items)).toEqual(["d:d3", "s:main", "d:d1", "s:rsi", "d:d2", "d:d4"]);
  });

  it("keeps the drawing order among drawings over the same source", () => {
    const items = paneItems(["main"], [{ id: "a", over: "main" }, { id: "b", over: "main" }]);
    expect(ids(items)).toEqual(["d:a", "d:b", "s:main"]);
  });

  it("empty pane / sources only / drawings only", () => {
    expect(paneItems([], [])).toEqual([]);
    expect(ids(paneItems(["main"], []))).toEqual(["s:main"]);
    expect(ids(paneItems([], [{ id: "a", over: "main" }]))).toEqual(["d:a"]);
  });
});

describe("moveItem", () => {
  const base = paneItems(["main", "rsi"], [{ id: "d1", over: "main" }, { id: "d2" }]);
  // d1, main, rsi, d2

  it("moves above / below the target", () => {
    expect(ids(moveItem(base, "d2", "main", false)!)).toEqual(["d:d1", "d:d2", "s:main", "s:rsi"]);
    expect(ids(moveItem(base, "d1", "rsi", true)!)).toEqual(["s:main", "s:rsi", "d:d1", "d:d2"]);
  });

  it("returns null when nothing moves or an id is missing", () => {
    expect(moveItem(base, "d1", "main", false)).toBeNull(); // already right above
    expect(moveItem(base, "d1", "d1", true)).toBeNull();
    expect(moveItem(base, "nope", "main", true)).toBeNull();
    expect(moveItem(base, "d1", "nope", true)).toBeNull();
  });

  it("does not mutate the input", () => {
    const copy = base.slice();
    moveItem(base, "d2", "d1", false);
    expect(base).toEqual(copy);
  });
});

describe("splitItems", () => {
  it("records for each drawing the source right behind it", () => {
    const items: TreeItem[] = [
      { kind: "drawing", id: "a" },
      { kind: "source", id: "main" },
      { kind: "drawing", id: "b" },
      { kind: "drawing", id: "c" },
      { kind: "source", id: "rsi" },
      { kind: "drawing", id: "z" },
    ];
    expect(splitItems(items)).toEqual({
      sources: ["main", "rsi"],
      drawings: ["a", "b", "c", "z"],
      over: { a: "main", b: "rsi", c: "rsi", z: null },
    });
  });

  it("round-trips with paneItems", () => {
    const items = paneItems(["main", "vol"], [{ id: "x", over: "vol" }, { id: "y", over: "main" }, { id: "w" }]);
    const s = splitItems(items);
    const again = paneItems(s.sources, s.drawings.map((id) => ({ id, over: s.over[id] ?? undefined })));
    expect(again).toEqual(items);
  });
});
