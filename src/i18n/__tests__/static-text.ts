/*
 * The interface text written in the code, as plain strings: what the page translator will meet on the page. Text built
 * at run time is not seen here. A text inside an element naming its sense (`data-i18n-sense="action"`) comes with that
 * sense.
 *
 * Read in .tsx files:
 * - JSX text, and the `title` / `placeholder` attributes (the ones the translator translates).
 * - Strings a JSX child or one of those attributes renders through an expression: `{"Text"}`, both branches of
 *   `{cond ? "A" : "B"}`, the right side of `{cond && "A"}`, either side of `{x ?? "A"}` / `{x || "A"}`. Only the
 *   strings that are shown: the condition (`kind === "log"`), call arguments, class names and styles are not read.
 * - Text props given to a component (`<Tab label="Log" />`, see TEXT_FIELDS), with the same expression rule. A plain
 *   element's other attributes (`class`, `href`, `aria-label`) are not shown as text.
 *
 * Read in .tsx and .ts files:
 * - The text fields of objects (`{ id: "log", label: "Log" }`): item arrays, menus, tabs and dialogs handed to a
 *   component that shows them. Only the fields in TEXT_FIELDS, so ids, values, keys, event names and kv keys are not
 *   read. Within those fields, a value starting in lowercase is not a text of its own: an id (`"log"`, `"chart-1"`) or
 *   a piece the code joins into a longer text (an undo step's `"move objects"`); nor is an id starting with a digit
 *   (`"1d"`) or a colour (`"#2962ff"`).
 * - The values of a constant named as a text map (`const TYPE_LABEL = { idea: "Idea" }`, `TAB_TITLES`, `RATING_TEXT`),
 *   with the same exceptions. A map whose values are only pieces of a longer text is named otherwise
 *   (`REASON_PHRASES`).
 * - The English template of `translateWith("{0} bars", n)` and the text of `translateAs("Close", "action")` (with its
 *   sense): the dictionary needs those entries too.
 */
import ts from "typescript";

export type StaticText = { text: string; file: string; line: number; sense?: string };

/** Attributes the translator translates. */
const ATTRIBUTES = new Set(["title", "placeholder"]);

/**
 * Fields of an object, and props of a component, whose string is shown to the user: a menu row's `label`, a dialog's
 * `mainText`, a tab's `title`. Not `name` or `description`: those are mostly script and tool definitions read by code
 * or by the agent.
 */
const TEXT_FIELDS = new Set([
  "label",
  "title",
  "text",
  "placeholder",
  "tooltip",
  "tip",
  "header",
  "desc",
  "mainText",
  "cancelText",
  "closeLabel",
  "menuLabel",
  "note",
]);

/** A constant mapping ids to what is shown for them: `TYPE_LABEL`, `TAB_TITLES`, `RATING_TEXT`. */
const TEXT_MAP = /(?:^|_)(?:LABEL|TITLE|TEXT)S?$/;

/** A value that names something for the code, not the user: `"1d"`, `"#2962ff"`. */
const ID_LIKE = /^(?:[0-9][a-z0-9_.:/-]*|#[0-9a-fA-F]{3,8})$/;

/** A field value starting in lowercase: a piece of a longer text built at run time ("Undo " + "move objects"). */
const FRAGMENT = /^[a-z]/;

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

/** The strings an expression can evaluate to as it is written: the literal, the branches of `?:`, `&&`, `||`, `??`. */
function shownStrings(e: ts.Expression): ts.StringLiteralLike[] {
  if (ts.isStringLiteralLike(e)) return [e];
  if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e)) return shownStrings(e.expression);
  if (ts.isConditionalExpression(e)) return [...shownStrings(e.whenTrue), ...shownStrings(e.whenFalse)];
  if (ts.isBinaryExpression(e)) {
    const op = e.operatorToken.kind;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) return shownStrings(e.right);
    if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) return [...shownStrings(e.left), ...shownStrings(e.right)];
  }
  return [];
}

/** A component (`<Tab>`, `<ui.Tab>`), not a plain element (`<div>`). */
function isComponent(tag: ts.JsxTagNameExpression, sf: ts.SourceFile): boolean {
  return /^[A-Z]|\./.test(tag.getText(sf));
}

/** The name of a property (`label`, `"label"`), undefined when computed. */
function propertyName(name: ts.PropertyName): string | undefined {
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : undefined;
}

/** The object is the value of a constant named as a text map (`const TYPE_LABEL = { idea: "Idea" }`). */
function inTextMap(obj: ts.Node): boolean {
  let n = obj.parent;
  while (ts.isAsExpression(n) || ts.isSatisfiesExpression(n) || ts.isParenthesizedExpression(n)) n = n.parent;
  return ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && TEXT_MAP.test(n.name.text);
}

/** Called as `translateWith(…)` or `translateAs(…)`. */
function translatorCall(e: ts.CallExpression): string | undefined {
  const callee = ts.isPropertyAccessExpression(e.expression) ? e.expression.name : e.expression;
  return ts.isIdentifier(callee) && (callee.text === "translateWith" || callee.text === "translateAs") ? callee.text : undefined;
}

export function staticTexts(file: string, source: string): StaticText[] {
  const tsx = file.endsWith(".tsx");
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, tsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: StaticText[] = [];
  const add = (text: string, node: ts.Node, sense = senseOf(node, sf)) => {
    const t = text.trim();
    if (!t) return;
    out.push({ text: t, file, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, ...(sense ? { sense } : {}) });
  };
  /** A field's or a prop's strings, ids and fragments left out. */
  const addField = (e: ts.Expression) => {
    for (const s of shownStrings(e)) if (!ID_LIKE.test(s.text) && !FRAGMENT.test(s.text)) add(s.text, s);
  };
  /** What a JSX child or a translated attribute renders. */
  const addShown = (e: ts.Expression) => {
    for (const s of shownStrings(e)) add(s.text, s);
  };
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node)) add(jsxText(node.text), node);
    else if (ts.isJsxExpression(node) && node.expression && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) addShown(node.expression);
    else if (ts.isJsxAttribute(node) && node.initializer) {
      const name = node.name.getText(sf);
      const init = node.initializer;
      const value = ts.isStringLiteral(init) ? init : ts.isJsxExpression(init) ? init.expression : undefined;
      if (value && ATTRIBUTES.has(name)) addShown(value);
      else if (value && TEXT_FIELDS.has(name) && isComponent(node.parent.parent.tagName, sf)) addField(value);
    } else if (ts.isPropertyAssignment(node) && TEXT_FIELDS.has(propertyName(node.name) ?? "")) addField(node.initializer);
    else if (ts.isPropertyAssignment(node) && inTextMap(node.parent)) {
      // A pair ("Annual", "FY") is two texts.
      const values = ts.isArrayLiteralExpression(node.initializer) ? node.initializer.elements : [node.initializer];
      for (const v of values) addField(v);
    } else if (ts.isCallExpression(node) && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
      const call = translatorCall(node);
      const sense = call === "translateAs" && node.arguments[1] && ts.isStringLiteralLike(node.arguments[1]) ? node.arguments[1].text : undefined;
      if (call) add(node.arguments[0].text, node.arguments[0], sense);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}
