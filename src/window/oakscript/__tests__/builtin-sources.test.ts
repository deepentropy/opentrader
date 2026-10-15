/**
 * Built-in sources (issue #73): which studies have a source, which are scripts without one, the
 * study menu row, and that a built-in's source runs as a user script with the worker's module set
 * (oakscriptjs + the indicator helpers) and computes what the built-in computes.
 */
import { describe, expect, it, vi } from "vitest";

const kv = vi.hoisted(() => ({ store: new Map<string, string>() }));
vi.mock("../../../data/kv", () => ({
  getItem: (k: string) => kv.store.get(k) ?? null,
  setItem: (k: string, v: string) => void kv.store.set(k, v),
  removeItem: (k: string) => void kv.store.delete(k),
  onExternalChange: () => () => undefined,
}));

import * as oak from "oakscriptjs";
import * as helpers from "lightweight-charts-indicators/helpers";
import { indicatorRegistry } from "lightweight-charts-indicators";
import {
  builtinName,
  builtinScriptId,
  builtinScriptRows,
  builtinTypeOf,
  builtinWithSource,
  loadBuiltinSource,
  sourceUnavailable,
} from "../builtin-sources";
import { editorScriptOfStudy } from "../editor-state";
import { sourceCodeMenuRows } from "../../chart/view/source-code-rows";
import * as scripts from "../../../data/oakscript-store";

const standard = indicatorRegistry.filter((e) => e.group === "standard");

describe("built-in sources", () => {
  it("has a source for each standard study (any instance), none for the app's own built-ins", () => {
    expect(builtinWithSource("rsi")).toBe("rsi");
    expect(builtinWithSource("rsi#3")).toBe("rsi");
    expect(builtinWithSource("volume")).toBeNull();
    expect(builtinWithSource("vbp-visible")).toBeNull();
    expect(builtinWithSource("user:abc")).toBeNull();
    expect(builtinScriptRows().map((r) => r.typeId).sort()).toEqual(standard.map((e) => e.id).sort());
    const names = builtinScriptRows().map((r) => r.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it("maps editor ids both ways and names a built-in by its registry name", () => {
    expect(builtinScriptId("rsi")).toBe("builtin:rsi");
    expect(builtinTypeOf("builtin:rsi")).toBe("rsi");
    expect(builtinTypeOf("1234-abcd")).toBeNull();
    expect(builtinName("rsi")).toBe(standard.find((e) => e.id === "rsi")!.name);
    expect(editorScriptOfStudy("rsi#2")).toBe("builtin:rsi");
    expect(editorScriptOfStudy("user:abc#2")).toBe("abc");
    expect(editorScriptOfStudy("strategy:user:abc")).toBe("abc");
    expect(editorScriptOfStudy("volume")).toBeNull();
  });

  it("knows the scripts whose source is not shipped", () => {
    expect(sourceUnavailable("abandoned-baby-bearish")).toBe(true); // candlestick pattern
    expect(sourceUnavailable("zlsma")).toBe(true); // community port
    expect(sourceUnavailable("strategy:bar-up-dn")).toBe(true); // built-in strategy
    expect(sourceUnavailable("strategy:user:abc")).toBe(false);
    expect(sourceUnavailable("rsi")).toBe(false);
    expect(sourceUnavailable("volume")).toBe(false);
  });

  it("gives the study menu one Source code row, disabled without a source, none for non-scripts", () => {
    const row = (id: string) => sourceCodeMenuRows(id) as { kind: string; label?: string; disabled?: boolean }[];
    expect(row("rsi#2")).toEqual([expect.objectContaining({ kind: "item", label: "Source code…", disabled: false })]);
    expect(row("user:abc")).toEqual([expect.objectContaining({ disabled: false })]);
    expect(row("doji")).toEqual([expect.objectContaining({ disabled: true })]);
    expect(row("strategy:bar-up-dn")).toEqual([expect.objectContaining({ disabled: true })]);
    expect(row("volume")).toEqual([]);
    expect(row("vbp-visible")).toEqual([]);
  });

  it("runs a built-in's source as a user script and computes the built-in's plots", async () => {
    (globalThis as Record<string, unknown>).__t73oak = oak;
    (globalThis as Record<string, unknown>).__t73helpers = helpers;
    const shim = (global: string, mod: Record<string, unknown>) =>
      "data:text/javascript," +
      encodeURIComponent(
        `const m = globalThis.${global};\n` +
          Object.keys(mod)
            .filter((k) => k !== "default" && /^[A-Za-z_$][\w$]*$/.test(k))
            .map((k) => `export const ${k} = m[${JSON.stringify(k)}];`)
            .join("\n"),
      );
    // Same specifier rewrite as the worker (oakscript-worker.ts rewriteImports).
    const oakUrl = shim("__t73oak", oak as unknown as Record<string, unknown>);
    const helpersUrl = shim("__t73helpers", helpers as unknown as Record<string, unknown>);
    const bars = Array.from({ length: 300 }, (_, i) => {
      const c = 100 + 10 * Math.sin(i / 7) + i * 0.05;
      return { time: 1_600_000_000 + i * 86_400, open: c - 0.5, high: c + 1, low: c - 1, close: c, volume: 1000 + (i % 13) * 50 };
    });
    for (const id of ["rsi", "macd", "bb", "pivot-points-high-low", "ichimoku"]) {
      const entry = standard.find((e) => e.id === id);
      if (!entry) continue;
      const src = (await loadBuiltinSource(id))!;
      expect(src, id).toMatch(/export function calculate/);
      const code = src
        .replace(/from 'oakscriptjs'/g, `from '${oakUrl}'`)
        .replace(/from 'lightweight-charts-indicators\/helpers'/g, `from '${helpersUrl}'`);
      const mod = await import(/* @vite-ignore */ "data:text/javascript," + encodeURIComponent(code));
      expect(mod.metadata.title, id).toBe(entry.metadata.title);
      expect(JSON.stringify(mod.calculate(bars, {}).plots), id).toBe(JSON.stringify(entry.calculate(bars, {}).plots));
    }
  });
});

describe("script copies", () => {
  it("creates a script with a given source, numbered as a new script", () => {
    kv.store.clear();
    const a = scripts.createScript(undefined, "// a");
    const b = scripts.createScript(undefined, "// b");
    expect(a.name).toBe("Untitled script");
    expect(b.name).toBe("Untitled script 2");
    expect(scripts.loadScript(b.id)?.source).toBe("// b");
  });

  it("copies a stored script under the given name, default \"<name> copy\"", () => {
    kv.store.clear();
    const s = scripts.createScript("My RSI", "// rsi");
    expect(scripts.duplicateScript(s.id)?.name).toBe("My RSI copy");
    const named = scripts.duplicateScript(s.id, "  Faster RSI ");
    expect(named?.name).toBe("Faster RSI");
    expect(named?.source).toBe("// rsi");
  });

  it("lists a built-in shown in the editor among the recent scripts", () => {
    kv.store.clear();
    const s = scripts.createScript("Mine");
    scripts.setCurrentScriptId(s.id);
    scripts.setCurrentScriptId("builtin:rsi");
    const named = (id: string) => (builtinTypeOf(id) ? builtinName(builtinTypeOf(id)!) : undefined);
    expect(scripts.recentScripts(named).map((m) => m.id)).toEqual(["builtin:rsi", s.id]);
    expect(scripts.recentScripts().map((m) => m.id)).toEqual([s.id]);
  });
});
