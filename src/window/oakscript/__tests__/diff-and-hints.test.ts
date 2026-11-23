/**
 * Diff decorations and import hints of the OakScript editor (#325): the changed blocks against the saved version,
 * the lines their gutter marks cover, "Discard changes", and the hint after each import.
 */
import { describe, expect, it } from "vitest";
import { diffLines, markedLines, revertHunk } from "../line-diff";
import { importHints } from "../import-hints";
import oakPackage from "../../../../node_modules/oakscriptjs/package.json";

const saved = ["a", "b", "c", "d", "e"].join("\n");

describe("diffLines", () => {
  it("finds nothing in the same text", () => {
    expect(diffLines(saved, saved)).toEqual([]);
  });

  it("finds a modified line", () => {
    const now = ["a", "B", "c", "d", "e"].join("\n");
    expect(diffLines(saved, now)).toEqual([{ kind: "modified", origStart: 2, origCount: 1, modStart: 2, modCount: 1 }]);
  });

  it("finds added and removed blocks apart", () => {
    const now = ["a", "x", "y", "b", "c", "e"].join("\n");
    expect(diffLines(saved, now)).toEqual([
      { kind: "added", origStart: 2, origCount: 0, modStart: 2, modCount: 2 },
      { kind: "removed", origStart: 4, origCount: 1, modStart: 6, modCount: 0 },
    ]);
  });

  it("marks a removal on the line above the gap, the first line at the top", () => {
    const [h] = diffLines(saved, ["b", "c", "d", "e"].join("\n"));
    expect(h.kind).toBe("removed");
    expect(markedLines(h)).toEqual({ from: 1, to: 1 });
    const [mid] = diffLines(saved, ["a", "b", "d", "e"].join("\n"));
    expect(markedLines(mid)).toEqual({ from: 2, to: 2 });
  });

  it("puts a block back as saved", () => {
    const now = ["a", "x", "y", "b", "c", "e"].join("\n");
    const [added, removed] = diffLines(saved, now);
    expect(revertHunk(saved, now, removed)).toBe(["a", "x", "y", "b", "c", "d", "e"].join("\n"));
    expect(revertHunk(saved, now, added)).toBe(["a", "b", "c", "e"].join("\n"));
  });
});

describe("importHints", () => {
  it("gives the version of a served package at the end of its import", () => {
    const src = 'const x = 1;\nimport { ta } from "oakscriptjs";\n';
    expect(importHints(src)).toEqual([{ line: 2, column: 34, version: oakPackage.version }]);
  });

  it("says a module the engine cannot load, also over several lines and as a bare import", () => {
    const src = 'import {\n  a,\n  b,\n} from "lodash";\nimport "./other.js";';
    expect(importHints(src)).toEqual([
      { line: 4, column: 17, version: null },
      { line: 5, column: 21, version: null },
    ]);
  });
});
