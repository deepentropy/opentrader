/*
 * Monaco bootstrap for the OakScript editor.
 *
 * Lives in the lazily-imported editor chunk (OakScriptEditor.tsx) so monaco's
 * ~3 MB never touches the main bundle — the chart startup path is unchanged
 * until the drawer first opens.
 *
 * IntelliSense: every oakscriptjs .d.ts (31 files, ~60 KB) is inlined at
 * build time via import.meta.glob(?raw) and mounted into monaco's virtual FS
 * under file:///node_modules/oakscriptjs/, so `import { ta } from
 * "oakscriptjs"` in a user script resolves with full typings. The path glob
 * reaches into node_modules directly because the package's exports map only
 * exposes "." and "./runtime", not the individual declaration files.
 *
 * Theme: fixed token colors, backgrounds from the app theme tokens at apply
 * time so light/dark switches follow the app.
 */
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import TsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

export { monaco };

const OAKSCRIPT_DTS = import.meta.glob("../../../node_modules/oakscriptjs/dist/**/*.d.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** Resolve a CSS custom property to #rrggbb for monaco (which rejects CSS
 *  color functions). Handles the #hex and rgb()/rgba() forms our tokens use. */
function cssHexColor(name: string, fallback: string): string {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (/^#[0-9a-f]{6}$/i.test(raw)) return raw;
  if (/^#[0-9a-f]{3}$/i.test(raw)) {
    return "#" + raw.slice(1).split("").map((c) => c + c).join("");
  }
  const m = raw.match(/^rgba?\(\s*(\d+)\s*[, ]\s*(\d+)\s*[, ]\s*(\d+)/);
  if (m) {
    const hex = (v: string) => Number(v).toString(16).padStart(2, "0");
    return `#${hex(m[1])}${hex(m[2])}${hex(m[3])}`;
  }
  return fallback;
}

let installed = false;

/** One-time worker + language service setup. Idempotent. */
export function setupMonaco(): void {
  if (installed) return;
  installed = true;

  self.MonacoEnvironment = {
    getWorker: (_workerId: string, label: string) =>
      label === "javascript" || label === "typescript" ? new TsWorker() : new EditorWorker(),
  };

  // monaco-editor 0.55 moved languages.typescript to the top-level
  // `typescript` export (CHANGELOG 0.53).
  const ts = monaco.typescript;
  const js = ts.javascriptDefaults;
  js.setCompilerOptions({
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    // No DOM lib: user scripts never touch the DOM, and its globals (close,
    // open, name, …) would collide with oakscriptjs's global Series (close,
    // open) declared below, mistyping them as Window methods.
    lib: ["esnext"],
    allowNonTsExtensions: true,
    allowJs: true,
    // Type-check user JS against the oakscriptjs typings (the API is fully
    // typed; default laxness — no noImplicitAny — keeps untyped code quiet).
    checkJs: true,
    noEmit: true,
    esModuleInterop: true,
    // Belt and braces for the bare "oakscriptjs" import: node resolution
    // finds it via the virtual node_modules + package.json below; the paths
    // mapping short-circuits it even if that lookup regresses.
    baseUrl: "file:///",
    paths: {
      oakscriptjs: ["node_modules/oakscriptjs/dist/index"],
      "oakscriptjs/script": ["node_modules/oakscriptjs/dist/script/index"],
      "oakscriptjs/runtime": ["node_modules/oakscriptjs/dist/runtime/index"],
    },
  });
  js.setDiagnosticsOptions({ noSemanticValidation: false, noSyntaxValidation: false });

  for (const [path, source] of Object.entries(OAKSCRIPT_DTS)) {
    const rel = path.slice(path.indexOf("oakscriptjs/"));
    js.addExtraLib(source, `file:///node_modules/${rel.replace(/\\/g, "/")}`);
  }
  js.addExtraLib(
    JSON.stringify({ name: "oakscriptjs", version: "0.8.1", types: "./dist/index.d.ts" }),
    "file:///node_modules/oakscriptjs/package.json",
  );

  // Script-style sources use the API as implicit globals (no import, Pine-like;
  // the worker injects the same set). Declare every value export of
  // oakscriptjs/script as an ambient global so autocomplete + type-check work
  // without an import. Parsed from the installed .d.ts so it tracks the package.
  const scriptDts = Object.entries(OAKSCRIPT_DTS).find(([p]) =>
    p.replace(/\\/g, "/").endsWith("oakscriptjs/dist/script/index.d.ts"),
  )?.[1];
  if (scriptDts) {
    const globals = scriptGlobalNames(scriptDts);
    if (globals.length) {
      const lib =
        "declare global {\n" +
        globals.map((n) => `  const ${n}: typeof import("oakscriptjs/script").${n};`).join("\n") +
        "\n}\nexport {};\n";
      js.addExtraLib(lib, "file:///oakscript-globals.d.ts");
    }
  }
}

/** Value export names of oakscriptjs/script, scraped from its .d.ts. Skips
 *  `export type` and the host-only `executeScript`. */
function scriptGlobalNames(dts: string): string[] {
  const names = new Set<string>();
  let m: RegExpExecArray | null;
  const reDecl = /export\s+declare\s+(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g;
  while ((m = reDecl.exec(dts))) names.add(m[1]);
  const reStarAs = /export\s+\*\s+as\s+([A-Za-z_$][\w$]*)/g;
  while ((m = reStarAs.exec(dts))) names.add(m[1]);
  // `export { A, isNA as na, nz }` — value re-exports; skip `export type { … }`.
  const reNamed = /export\s+(?!type\b)\{([^}]*)\}/g;
  while ((m = reNamed.exec(dts))) {
    for (const part of m[1].split(",")) {
      const t = part.trim();
      if (!t || /^type\s/.test(t)) continue;
      const as = t.match(/\bas\s+([A-Za-z_$][\w$]*)$/);
      const name = as ? as[1] : t;
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  names.delete("executeScript");
  return [...names];
}

/** (Re)define + activate the oak theme for the given app theme. Re-run on
 *  theme switches: backgrounds re-read the app tokens at call time. */
export function applyOakTheme(theme: "dark" | "light"): void {
  const bg = cssHexColor("--ot-chart-bg", theme === "dark" ? "#0f0f0f" : "#ffffff");
  if (theme === "dark") {
    // Token palette (DESIGN.md).
    monaco.editor.defineTheme("oak-dark", {
      base: "vs-dark",
      inherit: true,
      rules: [
        { token: "comment", foreground: "808080" },
        { token: "keyword", foreground: "42BDA8" },
        { token: "number", foreground: "F57F17" },
        { token: "string", foreground: "F77C80" },
        { token: "identifier", foreground: "DBDBDB" },
        { token: "type.identifier", foreground: "5B9CF6" },
      ],
      colors: {
        "editor.background": bg,
        "editorLineNumber.foreground": "#808080",
        "editorLineNumber.activeForeground": "#DBDBDB",
      },
    });
    monaco.editor.setTheme("oak-dark");
  } else {
    // No light token palette — monaco's stock light plus our bg.
    monaco.editor.defineTheme("oak-light", {
      base: "vs",
      inherit: true,
      rules: [],
      colors: { "editor.background": bg },
    });
    monaco.editor.setTheme("oak-light");
  }
}
