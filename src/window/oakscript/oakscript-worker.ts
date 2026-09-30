/*
 * oakscript-worker — executes user OakScript indicators off the main thread.
 *
 * The worker bundles oakscriptjs (vite builds ?worker entries as separate
 * chunks) and exposes it to user code through a generated ES-module shim: the
 * user source's `import ... from "oakscriptjs"` specifiers are rewritten to a
 * blob URL whose module re-exports every oakscriptjs binding from
 * globalThis.__oakscriptjs. The rewrite only touches the specifier string, so
 * user line/column numbers survive into runtime stack traces.
 *
 * Each compile imports the source as a real ES module via a blob URL — full
 * syntax (import/export) with no transpile step. A compiled module is cached
 * per scriptId for `run` requests. The host side (engine.ts) owns the
 * watchdog: a hung compile/run gets the whole worker terminated.
 */
import * as oak from "oakscriptjs";
import * as oakScript from "oakscriptjs/script";
import type { OakCompiledMeta, OakRequest, OakResponse, OakScriptError } from "./engine-types";
import { isConventionStyle, SCRIPT_LINE_OFFSET, wrapScriptStyle } from "./script-transform";
import { StrategyRuntimeError } from "../../backtester/broker";
import { BrokerEngine, brokerProperties, runOakScriptStrategy } from "../../backtester/oakscript";
import { DEFAULT_SYMBOL } from "../../backtester/types";

const ctx = self as unknown as {
  postMessage(message: OakResponse): void;
  onmessage: ((e: MessageEvent<OakRequest>) => void) | null;
};

(globalThis as Record<string, unknown>).__oakscriptjs = oak;
(globalThis as Record<string, unknown>).__oakscript_script = oakScript;

// Every value the script API exports, made implicit globals (Pine has no
// imports). Injected as a module-scope import so a user's local `const close`
// simply shadows it, and names the user imports are left out of it (no
// redeclaration error). `executeScript` is host-only.
const SCRIPT_GLOBALS = Object.keys(oakScript as Record<string, unknown>).filter(
  (k) => k !== "default" && k !== "executeScript" && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k),
);

/** Blob module re-exporting every binding of `mod` from a worker global —
 *  how user code shares the worker's own oakscriptjs instance. */
function makeShim(mod: Record<string, unknown>, globalName: string): string {
  const names = Object.keys(mod).filter(
    (k) => k !== "default" && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k),
  );
  const body =
    `const m = globalThis.${globalName};\n` +
    names.map((n) => `export const ${n} = m[${JSON.stringify(n)}];`).join("\n");
  return URL.createObjectURL(new Blob([body], { type: "text/javascript" }));
}

let baseShimUrl: string | null = null;
let scriptShimUrl: string | null = null;

/** Point the user's oakscriptjs imports (static or dynamic) at the shims. */
function rewriteImports(source: string): string {
  return source.replace(
    /(from\s*|import\s*\(\s*)(["'])(oakscriptjs(?:\/script)?)\2/g,
    (_m, pre: string, q: string, spec: string) => {
      const url =
        spec === "oakscriptjs/script"
          ? (scriptShimUrl ??= makeShim(oakScript as unknown as Record<string, unknown>, "__oakscript_script"))
          : (baseShimUrl ??= makeShim(oak as unknown as Record<string, unknown>, "__oakscriptjs"));
      return `${pre}${q}${url}${q}`;
    },
  );
}

/** Best-effort mapping of a thrown value to user-source coordinates: the
 *  first blob:...:line:col frame in the stack is the user module.
 *  `lineOffset` subtracts the wrap transform's shift for script-style code. */
function toScriptError(err: unknown, lineOffset = 0): OakScriptError {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? (err.stack ?? "") : "";
  // Lazy body + lookahead so the URL's own colons (blob:http://host:port/)
  // don't eat the trailing :line:col pair.
  const m = stack.match(/blob:[^\s)]+?:(\d+):(\d+)(?=[\s):]|$)/);
  if (m) return { message, line: Math.max(1, Number(m[1]) - lineOffset), col: Number(m[2]) };
  return { message };
}

type UserModule = Record<string, unknown> & {
  calculate?: (bars: unknown[], inputs?: Record<string, unknown>) => unknown;
  __run?: () => void;
};

type Compiled =
  | { kind: "convention"; mod: UserModule }
  | { kind: "script"; run: () => void };

const compiled = new Map<string, Compiled>();

function metaOf(mod: UserModule): OakCompiledMeta {
  const md = (mod.metadata ?? {}) as Record<string, unknown>;
  return {
    title: typeof md.title === "string" ? md.title : "Untitled",
    shortTitle: typeof md.shortTitle === "string" ? md.shortTitle : undefined,
    overlay: md.overlay !== false,
    inputConfig: Array.isArray(mod.inputConfig) ? mod.inputConfig : undefined,
    plotConfig: Array.isArray(mod.plotConfig) ? mod.plotConfig : undefined,
    hlineConfig: Array.isArray(mod.hlineConfig) ? mod.hlineConfig : undefined,
    fillConfig: Array.isArray(mod.fillConfig) ? mod.fillConfig : undefined,
    shapeConfig: Array.isArray(mod.shapeConfig) ? mod.shapeConfig : undefined,
    barColorConfig: Array.isArray(mod.barColorConfig) ? mod.barColorConfig : undefined,
    defaultInputs:
      mod.defaultInputs && typeof mod.defaultInputs === "object"
        ? (mod.defaultInputs as Record<string, unknown>)
        : undefined,
  };
}

/** ScriptRunResult (meta + configs) → the compile-response meta shape. */
function scriptMetaOf(run: oakScript.ScriptRunResult): OakCompiledMeta {
  return {
    title: run.metadata.title,
    shortTitle: run.metadata.shortTitle,
    overlay: run.metadata.overlay,
    inputConfig: run.inputConfig,
    plotConfig: run.plotConfig,
    hlineConfig: run.hlineConfig.length ? run.hlineConfig : undefined,
    fillConfig: run.fillConfig.length ? run.fillConfig : undefined,
    shapeConfig: run.shapeConfig.length ? run.shapeConfig : undefined,
    barColorConfig: run.barColorConfig.length ? run.barColorConfig : undefined,
    defaultInputs: run.defaultInputs,
    strategy: run.strategyConfig as Record<string, unknown> | undefined,
  };
}

async function handleCompile(req: Extract<OakRequest, { type: "compile" }>): Promise<OakResponse> {
  const scriptStyle = !isConventionStyle(req.source);
  const source = scriptStyle ? wrapScriptStyle(req.source, SCRIPT_GLOBALS) : req.source;
  const lineOffset = scriptStyle ? SCRIPT_LINE_OFFSET : 0;
  const url = URL.createObjectURL(new Blob([rewriteImports(source)], { type: "text/javascript" }));
  try {
    const mod = (await import(/* @vite-ignore */ url)) as UserModule;
    if (scriptStyle) {
      if (typeof mod.__run !== "function") {
        return { id: req.id, type: "compile", ok: false, error: { message: "Script transform failed." } };
      }
      // Dry run on zero bars registers the declarations (metadata, inputs,
      // plots) without computing anything — Pine's compile step.
      // A strategy gets an engine on the same zero bars, so strategy.eachBar() runs (no bar).
      const dry = oakScript.executeScript(mod.__run, [], {}, {}, {
        strategyEngine: ({ properties }) => new BrokerEngine([], brokerProperties(properties), DEFAULT_SYMBOL),
      });
      compiled.set(req.scriptId, { kind: "script", run: mod.__run });
      return { id: req.id, type: "compile", ok: true, meta: scriptMetaOf(dry) };
    }
    if (typeof mod.calculate !== "function") {
      return {
        id: req.id,
        type: "compile",
        ok: false,
        error: {
          message:
            'Script must export a function "calculate(bars, inputs)" or use the oakscriptjs/script API.',
        },
      };
    }
    compiled.set(req.scriptId, { kind: "convention", mod });
    return { id: req.id, type: "compile", ok: true, meta: metaOf(mod) };
  } catch (err) {
    return { id: req.id, type: "compile", ok: false, error: toScriptError(err, lineOffset) };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function handleRun(req: Extract<OakRequest, { type: "run" }>): OakResponse {
  const entry = compiled.get(req.scriptId);
  if (!entry) {
    return {
      id: req.id,
      type: "run",
      ok: false,
      error: { message: "Script is not compiled — save it (or fix compile errors) first." },
    };
  }
  try {
    if (entry.kind === "script") {
      const run = oakScript.executeScript(entry.run, req.bars as never[], req.inputs ?? {});
      return { id: req.id, type: "run", ok: true, result: run.result };
    }
    const result = entry.mod.calculate!(req.bars, req.inputs ?? {});
    return { id: req.id, type: "run", ok: true, result };
  } catch (err) {
    return {
      id: req.id,
      type: "run",
      ok: false,
      error: toScriptError(err, entry.kind === "script" ? SCRIPT_LINE_OFFSET : 0),
    };
  }
}

/** Backtest of a compiled strategy script on the OpenTrader broker. */
function handleBacktest(req: Extract<OakRequest, { type: "backtest" }>): OakResponse {
  const entry = compiled.get(req.scriptId);
  if (!entry || entry.kind !== "script") {
    const message = entry
      ? "Only scripts written with the oakscriptjs/script API can declare a strategy."
      : "Script is not compiled — save it (or fix compile errors) first.";
    return { id: req.id, type: "backtest", ok: false, error: { message } };
  }
  try {
    const { report } = runOakScriptStrategy(entry.run, req.bars, {
      inputs: req.inputs ?? {},
      properties: req.properties,
    });
    if (!report) {
      return {
        id: req.id,
        type: "backtest",
        ok: false,
        error: { message: "The script must declare strategy() and run its logic in strategy.eachBar()." },
      };
    }
    return { id: req.id, type: "backtest", ok: true, report };
  } catch (err) {
    if (err instanceof StrategyRuntimeError) {
      return { id: req.id, type: "backtest", ok: false, error: { message: err.message, code: err.code, bar: err.bar } };
    }
    return { id: req.id, type: "backtest", ok: false, error: toScriptError(err, SCRIPT_LINE_OFFSET) };
  }
}

ctx.onmessage = (e: MessageEvent<OakRequest>) => {
  const req = e.data;
  if (req.type === "compile") {
    void handleCompile(req).then((res) => ctx.postMessage(res));
  } else if (req.type === "backtest") {
    ctx.postMessage(handleBacktest(req));
  } else {
    ctx.postMessage(handleRun(req));
  }
};
