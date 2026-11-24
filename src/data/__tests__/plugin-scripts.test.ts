import { describe, expect, it } from "vitest";
import type { PluginScripts } from "../../bindings";
import { changedScripts, isPluginScriptId, pluginScriptId, scriptsById } from "../plugin-scripts";
import { loadScript, saveCompiledMeta } from "../oakscript-store";

const set = (scripts: PluginScripts["scripts"]): PluginScripts[] => [{ plugin: "algo", pluginName: "OpenAlgo", scripts }];

describe("plugin scripts", () => {
  it("names each script after its plugin and reads its kind", () => {
    const byId = scriptsById(
      set([
        { id: "piv", name: "Pivots", kind: null, source: 'indicator("P")' },
        { id: "flow", name: "Flow", kind: null, source: '// x\n  strategy("F", { overlay: true })' },
        { id: "said", name: "Said", kind: "indicator", source: 'strategy("S")' },
      ]),
    );
    expect([...byId.keys()]).toEqual(["plugin:algo:piv", "plugin:algo:flow", "plugin:algo:said"]);
    expect([...byId.values()].map((s) => s.kind)).toEqual(["indicator", "strategy", "indicator"]);
    expect(byId.get("plugin:algo:piv")?.pluginName).toBe("OpenAlgo");
    expect(isPluginScriptId(pluginScriptId("algo", "piv"))).toBe(true);
    expect(isPluginScriptId("6f1c-uuid")).toBe(false);
  });

  it("finds the scripts that came, changed or went", () => {
    const a = scriptsById(set([{ id: "a", name: "A", kind: null, source: "1" }, { id: "b", name: "B", kind: null, source: "1" }]));
    const b = scriptsById(set([{ id: "a", name: "A", kind: null, source: "2" }, { id: "c", name: "C", kind: null, source: "1" }]));
    expect([...changedScripts(a, b)].sort()).toEqual(["plugin:algo:a", "plugin:algo:b", "plugin:algo:c"]);
    expect(changedScripts(a, a).size).toBe(0);
  });

  it("is not a stored script: unknown ids load nothing and keep no meta", () => {
    saveCompiledMeta("plugin:algo:none", { title: "x" } as never);
    expect(loadScript("plugin:algo:none")).toBeNull();
  });
});
