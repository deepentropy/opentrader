import { afterEach, describe, expect, it } from "vitest";
import { instrumentSource, PROFILE_GLOBAL } from "../instrument";
import { ProfileCollector } from "../collect";

/** Runs plain (non-module) `source` instrumented: its return value and the profile of the run. */
function run(source: string) {
  const { code, spans } = instrumentSource(source);
  const profile = new ProfileCollector(spans);
  const value = profile.measure(() => new Function(code)());
  return { value, code, spans, profile: profile.snapshot() };
}

const at = (p: ReturnType<typeof run>["profile"], line: number) => p.lines.find((l) => l.lines[0] === line);

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[PROFILE_GLOBAL];
});

describe("instrumentSource", () => {
  it("keeps every line where it was and the result of the code", () => {
    const source = ["let s = 0;", "for (let i = 0; i < 10; i++) {", "  s += i;", "}", "return s;"].join("\n");
    const r = run(source);
    expect(r.code.split("\n").length).toBe(source.split("\n").length);
    expect(r.value).toBe(45);
  });

  it("counts executions by statement; a loop is a code block over its lines", () => {
    const r = run(["let s = 0;", "for (let i = 0; i < 10; i++) {", "  s += i;", "}", "return s;"].join("\n"));
    expect(at(r.profile, 1)).toMatchObject({ lines: [1], invocations: 1 });
    expect(at(r.profile, 2)).toMatchObject({ lines: [2, 4], invocations: 1 });
    expect(at(r.profile, 3)).toMatchObject({ lines: [3], invocations: 10 });
    expect(at(r.profile, 5)).toMatchObject({ lines: [5], invocations: 1 });
    expect(r.profile.total).toBeGreaterThan(0);
  });

  it("keeps declarations in their scope (const / let / function / class) and function names", () => {
    const r = run(
      [
        "const a = 1, b = 2;",
        "function f(x) { return x * 2; }",
        "class C { m() { return a + b; } }",
        "const g = (y) => {",
        "  const z = y + 1;",
        "  return z;",
        "};",
        "const h = [1, 2].map((v) => {",
        "  return v + 1;",
        "});",
        "return [f(a), new C().m(), g(3), f.name, g.name, h];",
      ].join("\n"),
    );
    expect(r.value).toEqual([2, 3, 4, "f", "g", [2, 3]]);
    // one execution for a declaration of two values
    expect(at(r.profile, 1)!.invocations).toBe(1);
    // a function value is not timed, its statements are
    expect(at(r.profile, 4)).toBeUndefined();
    expect(at(r.profile, 5)!.invocations).toBe(1);
    // a statement whose callback has statements is a code block
    expect(at(r.profile, 8)!.lines).toEqual([8, 10]);
    expect(at(r.profile, 9)!.invocations).toBe(2);
  });

  it("keeps break, continue (labelled too), return, switch fall-through and try / catch / finally", () => {
    const r = run(
      [
        "const out = [];",
        "outer: for (let i = 0; i < 4; i++) {",
        "  for (let j = 0; j < 4; j++) {",
        "    if (j === 2) continue outer;",
        "    if (i === 3) break outer;",
        "    out.push(i * 10 + j);",
        "  }",
        "}",
        "switch (out.length) {",
        "  case 6: out.push('six');",
        "  case 7: out.push('fell'); break;",
        "  default: out.push('no');",
        "}",
        "try { throw new Error('x'); } catch (e) { out.push(e.message); } finally { out.push('f'); }",
        "const first = (() => { for (const v of out) { if (typeof v === 'string') return v; } return null; })();",
        "out.push(first);",
        "return out;",
      ].join("\n"),
    );
    expect(r.value).toEqual([0, 1, 10, 11, 20, 21, "six", "fell", "x", "f", "six"]);
    expect(at(r.profile, 6)!.invocations).toBe(6);
  });

  it("times an if, its single-statement branches and an else if", () => {
    const r = run(["let n = 0;", "for (let i = 0; i < 5; i++)", "  if (i % 2) n += 1;", "  else if (i === 4) n += 10;", "  else n += 100;", "return n;"].join("\n"));
    expect(r.value).toBe(212);
    expect(at(r.profile, 3)).toMatchObject({ lines: [3, 5], invocations: 5 });
  });

  it("leaves directives and imports / exports as they are", () => {
    const { code } = instrumentSource(['"use strict";', 'import { x } from "y";', "export const a = x;", "export function calculate() { return a; }"].join("\n"));
    expect(code.startsWith('"use strict";\nimport { x } from "y";\nexport const a = ')).toBe(true);
    expect(code).toContain("export function calculate() { return __oakProfile.x(");
  });

  it("throws on a source that does not parse", () => {
    expect(() => instrumentSource("const = 1;")).toThrow(SyntaxError);
  });
});
