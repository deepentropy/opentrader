/*
 * Inlay hints for imports (#325, Editor settings "Inlay hints for imports"). The reference's hints show what an import
 * loads (its alias, its loading status). A script's imports name their bindings themselves, so the hint here says
 * which package version an import loads, or that the script engine cannot load it (the worker serves only the
 * packages below, oakscript-worker.ts). Pure: the editor turns the hints into Monaco inlay hints.
 */
import oakPackage from "../../../node_modules/oakscriptjs/package.json";
import indicatorsPackage from "../../../node_modules/lightweight-charts-indicators/package.json";

/** Version of each module a script can import (the worker's shims). */
const SERVED: Record<string, string> = {
  oakscriptjs: oakPackage.version,
  "oakscriptjs/script": oakPackage.version,
  "lightweight-charts-indicators/helpers": indicatorsPackage.version,
};

export type ImportHint = {
  /** 1-based line and column at the end of the import statement (after its semicolon, if any). */
  line: number;
  column: number;
  /** The package version the import loads; null when the engine cannot load the module. */
  version: string | null;
};

/** Static imports at the start of a line: `import … from "x";` (also over several lines) and `import "x";`. */
const IMPORT_RE = /^[ \t]*import\b(?:[^"'`;]*?\bfrom[ \t]*|[ \t]*)(["'])([^"'\n]+)\1(?:[ \t]*;)?/gm;

export function importHints(source: string): ImportHint[] {
  const hints: ImportHint[] = [];
  IMPORT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = IMPORT_RE.exec(source))) {
    const end = m.index + m[0].length;
    const before = source.slice(0, end);
    const line = before.split("\n").length;
    const column = end - before.lastIndexOf("\n");
    hints.push({ line, column, version: SERVED[m[2]] ?? null });
  }
  return hints;
}
