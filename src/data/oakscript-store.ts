/*
 * oakscript-store — kv-backed persistence for user OakScript indicators.
 *
 * Layout mirrors the other kv stores: an index of {id, name} under one key,
 * each script body under its own `ot:oakscript:script:<id>` key so saving one
 * script never rewrites the others. Scripts follow the
 * lightweight-charts-indicators file convention (metadata / inputConfig /
 * plotConfig / defaultInputs / calculate) so a saved script can be fed to the
 * existing indicator pipeline unchanged (phase 6).
 */
import * as kv from "./kv";

export type OakScript = {
  id: string;
  name: string;
  source: string;
  createdAt: number;
  updatedAt: number;
  /** Declarative surface captured at the last successful compile
   *  (OakCompiledMeta shape) — lets a chart build the indicator entry
   *  synchronously at startup, before the worker has compiled anything. */
  meta?: import("../window/oakscript/engine-types").OakCompiledMeta;
};

export type OakScriptMeta = { id: string; name: string };

const INDEX_KEY = "ot:oakscript:scripts";
const CURRENT_KEY = "ot:oakscript:currentScript";
const SCRIPT_PREFIX = "ot:oakscript:script:";

/** New-script template — the PineScript-style script API, used as implicit
 *  globals (no import; the worker injects them). An explicit
 *  `import … from "oakscriptjs/script"` still works, and the
 *  lightweight-charts-indicators convention (export calculate() + configs)
 *  also works: any indicator source from that repo is valid starting
 *  content. */
export const DEFAULT_SCRIPT_NAME = "Untitled script";
const DEFAULT_TEMPLATE = `// OakScript indicator — PineScript-style API.
// The API (indicator, plot, ta, close, …) is available globally, no import.

indicator("My SMA", { shorttitle: "SMA", overlay: true });

const length = input.int(20, "Length", { minval: 1 });
const src = input.source("close", "Source");
const sma = ta.sma(src, length);

plot(sma, "SMA", { color: "#2962FF" });

// Marker where price crosses above the average.
plotshape(ta.crossover(close, sma), "Cross Up", {
  style: "triangleup",
  location: "belowbar",
  color: "#26A69A",
  size: "small",
});

// Tint the chart background by trend.
bgcolor(color.when(close.gt(sma), "rgba(38,166,154,0.08)", "rgba(239,83,80,0.08)"));
`;

function readIndex(): OakScriptMeta[] {
  try {
    const parsed = JSON.parse(kv.getItem(INDEX_KEY) ?? "[]");
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (m): m is OakScriptMeta => !!m && typeof m.id === "string" && typeof m.name === "string",
      );
    }
  } catch {
    /* corrupt index — rebuild empty */
  }
  return [];
}

function writeIndex(index: OakScriptMeta[]): void {
  kv.setItem(INDEX_KEY, JSON.stringify(index));
}

export function listScripts(): OakScriptMeta[] {
  return readIndex();
}

export function loadScript(id: string): OakScript | null {
  const raw = kv.getItem(SCRIPT_PREFIX + id);
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as OakScript;
    return typeof s?.id === "string" && typeof s?.source === "string" ? s : null;
  } catch {
    return null;
  }
}

export function saveScript(script: OakScript): void {
  kv.setItem(SCRIPT_PREFIX + script.id, JSON.stringify(script));
  const index = readIndex();
  const entry = index.find((m) => m.id === script.id);
  if (!entry) index.push({ id: script.id, name: script.name });
  else if (entry.name !== script.name) entry.name = script.name;
  else return; // body saved, index unchanged
  writeIndex(index);
}

export function createScript(name?: string): OakScript {
  if (!name) {
    // "Untitled script", "Untitled script 2", ... (new scripts are numbered).
    const taken = new Set(readIndex().map((m) => m.name));
    name = DEFAULT_SCRIPT_NAME;
    for (let n = 2; taken.has(name); n++) name = `${DEFAULT_SCRIPT_NAME} ${n}`;
  }
  const now = Date.now();
  const script: OakScript = {
    id: crypto.randomUUID(),
    name,
    source: DEFAULT_TEMPLATE,
    createdAt: now,
    updatedAt: now,
  };
  saveScript(script);
  return script;
}

export function currentScriptId(): string | null {
  return kv.getItem(CURRENT_KEY);
}

export function setCurrentScriptId(id: string): void {
  kv.setItem(CURRENT_KEY, id);
}

/** The script the editor opens on: the persisted current one, else the first
 *  in the index, else a fresh template script. */
export function ensureCurrentScript(): OakScript {
  const id = currentScriptId();
  if (id) {
    const s = loadScript(id);
    if (s) return s;
  }
  const first = readIndex()[0];
  if (first) {
    const s = loadScript(first.id);
    if (s) {
      setCurrentScriptId(s.id);
      return s;
    }
  }
  const created = createScript();
  setCurrentScriptId(created.id);
  return created;
}

/** Persist the declarative surface of the last successful compile. */
export function saveCompiledMeta(
  id: string,
  meta: NonNullable<OakScript["meta"]>,
): void {
  const script = loadScript(id);
  if (!script) return;
  script.meta = meta;
  saveScript(script);
}

/** Editor autosave path — update one script's body in place. Keyed by id (not
 *  "current") so a debounced save that lands after a script switch can never
 *  write into the wrong script. */
export function saveSource(id: string, source: string): void {
  const script = loadScript(id);
  if (!script || script.source === source) return;
  script.source = source;
  script.updatedAt = Date.now();
  saveScript(script);
}

export function renameScript(id: string, name: string): void {
  const script = loadScript(id);
  const trimmed = name.trim();
  if (!script || !trimmed || script.name === trimmed) return;
  script.name = trimmed;
  script.updatedAt = Date.now();
  saveScript(script);
}

export function duplicateScript(id: string): OakScript | null {
  const script = loadScript(id);
  if (!script) return null;
  const now = Date.now();
  const copy: OakScript = {
    ...script,
    id: crypto.randomUUID(),
    name: `${script.name} (copy)`,
    createdAt: now,
    updatedAt: now,
  };
  saveScript(copy);
  return copy;
}

export function deleteScript(id: string): void {
  kv.removeItem(SCRIPT_PREFIX + id);
  writeIndex(readIndex().filter((m) => m.id !== id));
  if (currentScriptId() === id) kv.removeItem(CURRENT_KEY);
}
