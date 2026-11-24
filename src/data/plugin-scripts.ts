/*
 * Data plugins' scripts (#402, `data.scripts` in plugins/PROTOCOL.md): OakScript studies and strategies a plugin ships
 * with their source. Each one is the script `plugin:<plugin>:<id>`, which the script store (oakscript-store
 * loadScript) hands to the charts, alerts, the Strategy Tester and the screener as it does the user's own scripts. It
 * is read-only: the editor shows it as it does a built-in, with "Make a copy". The Indicators dialog lists them under
 * the plugin's name. The app keeps them while the plugin reconnects; they go when it stops serving data, and a chart
 * showing one then draws nothing, as for a deleted script.
 */
import { createSignal } from "solid-js";
import { commands, events, type PluginScripts } from "../bindings";
import type { OakCompiledMeta } from "../window/oakscript/engine-types";

export const PLUGIN_SCRIPT_PREFIX = "plugin:";

export const isPluginScriptId = (id: string): boolean => id.startsWith(PLUGIN_SCRIPT_PREFIX);
export const pluginScriptId = (plugin: string, id: string): string => `${PLUGIN_SCRIPT_PREFIX}${plugin}:${id}`;

export type PluginScriptItem = {
  /** Its script id, `plugin:<plugin>:<id>`. */
  id: string;
  name: string;
  source: string;
  kind: "indicator" | "strategy";
  plugin: string;
  pluginName: string;
};

const [sets, setSets] = createSignal<PluginScripts[]>([]);
/** The data plugins' scripts, by plugin (empty outside the desktop app). */
export function pluginScriptSets(): PluginScripts[] {
  listen();
  return sets();
}

let byId = new Map<string, PluginScriptItem>();
/** The meta of each script's last compile, with the source it was compiled from. */
const metas = new Map<string, { source: string; meta: OakCompiledMeta }>();
const listeners: ((ids: Set<string>) => void)[] = [];

/** A script declares itself a strategy when the plugin doesn't say: `strategy(` opens a line. */
const STRATEGY_CALL = /^\s*strategy\s*\(/m;

/** The scripts that changed between two sets: added, removed, or with another name or source. Exported for tests. */
export function changedScripts(before: Map<string, PluginScriptItem>, after: Map<string, PluginScriptItem>): Set<string> {
  const out = new Set<string>();
  for (const [id, s] of after) {
    const was = before.get(id);
    if (!was || was.source !== s.source || was.name !== s.name || was.kind !== s.kind) out.add(id);
  }
  for (const id of before.keys()) if (!after.has(id)) out.add(id);
  return out;
}

/** The scripts of a set by script id. Exported for tests. */
export function scriptsById(next: PluginScripts[]): Map<string, PluginScriptItem> {
  const out = new Map<string, PluginScriptItem>();
  for (const set of next) {
    for (const s of set.scripts) {
      const id = pluginScriptId(set.plugin, s.id);
      const kind = s.kind === "strategy" || s.kind === "indicator" ? s.kind : STRATEGY_CALL.test(s.source) ? "strategy" : "indicator";
      out.set(id, { id, name: s.name, source: s.source, kind, plugin: set.plugin, pluginName: set.pluginName });
    }
  }
  return out;
}

function take(next: PluginScripts[]): void {
  const after = scriptsById(next);
  const changed = changedScripts(byId, after);
  byId = after;
  for (const id of changed) if (!after.has(id)) metas.delete(id);
  setSets(next);
  if (changed.size) for (const l of listeners) l(changed);
}

let listening = false;
/** Read the plugins' scripts, and again whenever one sends its own: from the first use in a window (a chart restoring
 *  a plugin's study, the Indicators dialog). */
function listen(): void {
  if (listening || typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
  listening = true;
  const read = () => void commands.pluginScripts().then(take, () => undefined);
  void events.pluginScriptsChanged.listen(read);
  read();
}

/** Plugin script `id`, undefined when no plugin sends it (now). */
export function pluginScript(id: string): PluginScriptItem | undefined {
  pluginScriptSets(); // a reactive read: lists built from it follow the plugins
  return byId.get(id);
}

/** Every plugin script: the plugins by name, each one's scripts in its own order. */
export function pluginScriptList(): PluginScriptItem[] {
  pluginScriptSets();
  return [...byId.values()];
}

/** The meta of the script's last compile, while its source is the same. */
export function pluginScriptMeta(id: string): OakCompiledMeta | undefined {
  const m = metas.get(id);
  return m && m.source === byId.get(id)?.source ? m.meta : undefined;
}

export function setPluginScriptMeta(id: string, meta: OakCompiledMeta): void {
  const s = byId.get(id);
  if (s) metas.set(id, { source: s.source, meta });
}

/** Whether plugin script `id` goes on a chart as a strategy: its compile says so, else the plugin or its source. */
export function isPluginStrategy(id: string): boolean {
  const meta = pluginScriptMeta(id);
  return meta ? !!meta.strategy : byId.get(id)?.kind === "strategy";
}

/** Call `fn` with the ids of the scripts that came, changed or went; returns the stop. */
export function onPluginScriptsChanged(fn: (ids: Set<string>) => void): () => void {
  listeners.push(fn);
  return () => {
    const i = listeners.indexOf(fn);
    if (i >= 0) listeners.splice(i, 1);
  };
}
