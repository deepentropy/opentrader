/*
 * Source transform of script-style OakScript (oakscriptjs/script API), used by
 * oakscript-worker.ts. Pure string functions, so they are testable without a
 * worker.
 */

/** Convention-style (lightweight-charts-indicators) sources export a
 *  `calculate()` function. Everything else is script-style: its whole body
 *  re-runs per recalculation, with the script API available as implicit
 *  globals (no import needed, though an explicit one still works). */
export function isConventionStyle(source: string): boolean {
  return (
    /export\s+(?:async\s+)?function\s+calculate\b/.test(source) ||
    /export\s+(?:const|let|var)\s+calculate\b/.test(source) ||
    /export\s*\{[^}]*\bcalculate\b[^}]*\}/.test(source)
  );
}

/** Matches static import statements (incl. multi-line and side-effect form). */
const IMPORT_RE = /^[ \t]*import\b[\s\S]*?from[ \t]*["'][^"']+["'][ \t]*;?|^[ \t]*import[ \t]*["'][^"']+["'][ \t]*;?/gm;

const IDENT = /^[A-Za-z_$][\w$]*$/;

/** Local names an import statement binds: default, `* as ns`, `{ a, b as c }`. */
export function importBindings(statement: string): string[] {
  const m = statement.match(/^\s*import\s+([\s\S]*?)\s*from\s*["']/);
  if (!m) return []; // side-effect import
  const clause = m[1];
  const names: string[] = [];
  const ns = clause.match(/\*\s*as\s+([A-Za-z_$][\w$]*)/);
  if (ns) names.push(ns[1]);
  const braces = clause.match(/\{([^}]*)\}/);
  if (braces) {
    for (const part of braces[1].split(",")) {
      const t = part.trim();
      if (!t) continue;
      const as = t.match(/\bas\s+([A-Za-z_$][\w$]*)$/);
      const name = as ? as[1] : t;
      if (IDENT.test(name)) names.push(name);
    }
  }
  const first = clause.replace(/\{[^}]*\}/, "").replace(/\*\s*as\s+[A-Za-z_$][\w$]*/, "").split(",")[0].trim();
  if (IDENT.test(first)) names.push(first);
  return names;
}

/** Generated line N + 1 holds the user's line N. */
export const SCRIPT_LINE_OFFSET = 1;

/** Make the module body re-runnable: put the injected script-API import plus
 *  the user's own imports onto generated line 1, and wrap everything else in
 *  `export function __run()`. A name the user imports (from "oakscriptjs",
 *  "oakscriptjs/script" or elsewhere) is left out of the injected import, so
 *  the two never declare the same binding; the user's import wins. Every
 *  original line N lands on generated line N+1 (SCRIPT_LINE_OFFSET), keeping
 *  error positions exact. */
export function wrapScriptStyle(source: string, globals: readonly string[]): string {
  const userImports: string[] = [];
  const bound = new Set<string>();
  const blanked = source.replace(IMPORT_RE, (m) => {
    userImports.push(m.replace(/\n/g, " ").trim());
    for (const name of importBindings(m)) bound.add(name);
    return m.replace(/[^\n]/g, "");
  });
  const injected = globals.filter((g) => !bound.has(g));
  const preamble = `import { ${injected.join(", ")} } from "oakscriptjs/script"; ${userImports.join(" ")}`;
  return `${preamble} export function __run() {\n${blanked}\n}`;
}
