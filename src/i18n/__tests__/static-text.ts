/*
 * The interface text written in the components: JSX text, and the `title` / `placeholder` attributes (what the page
 * translator translates), when given as plain strings. Text built at run time is not seen here. A text inside an element
 * naming its sense (`data-i18n-sense="action"`) comes with that sense.
 */
import ts from "typescript";

export type StaticText = { text: string; file: string; line: number; sense?: string };

/** Attributes the translator translates. */
const ATTRIBUTES = new Set(["title", "placeholder"]);

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decode = (s: string) => s.replace(/&(\w+);/g, (all, name: string) => ENTITIES[name] ?? all);

/** JSX text as it reaches the page: each line trimmed, the lines joined by a space. */
function jsxText(raw: string): string {
  return decode(
    raw
      .split(/\r?\n/)
      .map((l, i, all) => (i === 0 ? (all.length > 1 ? l.trimEnd() : l) : i === all.length - 1 ? l.trimStart() : l.trim()))
      .filter((l) => l !== "")
      .join(" "),
  );
}

/** The `data-i18n-sense` of the closest element around `node` that names one. */
function senseOf(node: ts.Node, sf: ts.SourceFile): string | undefined {
  for (let n: ts.Node | undefined = node; n; n = n.parent) {
    const tag = ts.isJsxElement(n) ? n.openingElement : ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n) ? n : null;
    const attr = tag?.attributes.properties.find((a) => ts.isJsxAttribute(a) && a.name.getText(sf) === "data-i18n-sense") as ts.JsxAttribute | undefined;
    if (attr?.initializer && ts.isStringLiteral(attr.initializer)) return attr.initializer.text;
  }
  return undefined;
}

export function staticTexts(file: string, source: string): StaticText[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: StaticText[] = [];
  const add = (text: string, node: ts.Node) => {
    const t = text.trim();
    if (!t) return;
    const sense = senseOf(node, sf);
    out.push({ text: t, file, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, ...(sense ? { sense } : {}) });
  };
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node)) add(jsxText(node.text), node);
    else if (ts.isJsxAttribute(node) && ATTRIBUTES.has(node.name.getText(sf))) {
      const init = node.initializer;
      if (init && ts.isStringLiteral(init)) add(init.text, init);
      else if (init && ts.isJsxExpression(init) && init.expression && ts.isStringLiteralLike(init.expression)) add(init.expression.text, init);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}
