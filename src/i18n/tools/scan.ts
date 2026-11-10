/*
 * The interface text written in the code, as plain strings: what the page translator will meet on the page. The
 * English catalog (catalog.ts) is built from it. A text inside an element naming its sense (`data-i18n-sense="action"`)
 * comes with that sense.
 *
 * Read in .tsx files:
 * - JSX text, and the `title` / `placeholder` attributes (the ones the translator translates).
 * - Strings a JSX child or one of those attributes renders through an expression: `{"Text"}`, both branches of
 *   `{cond ? "A" : "B"}`, the right side of `{cond && "A"}`, either side of `{x ?? "A"}` / `{x || "A"}`. Only the
 *   strings that are shown: the condition (`kind === "log"`), call arguments, class names and styles are not read.
 * - Text props given to a component (`<Tab label="Log" />`, see TEXT_FIELDS), with the same expression rule, and the
 *   strings of an `options` list (`<Select options={["Values", "Percents"]} />`). A plain element's other attributes
 *   (`class`, `href`, `aria-label`) are not shown as text.
 *
 * Read in .tsx and .ts files:
 * - The text fields of objects (`{ id: "log", label: "Log" }`): item arrays, menus, tabs and dialogs handed to a
 *   component that shows them. Only the fields in TEXT_FIELDS, so ids, values, keys, event names and kv keys are not
 *   read. Within those fields, a value starting in lowercase is not a text of its own: an id (`"log"`, `"chart-1"`);
 *   nor is an id starting with a digit (`"1d"`) or a colour (`"#2962ff"`).
 * - A select's choices in an object: `options: ["Left", "Right"]`, or `options: SESSION_OPTIONS` naming a list of
 *   the file (a constant ending in `_OPTIONS`), with the same exceptions.
 * - The values of a constant named as a text map (`const TYPE_LABEL = { idea: "Idea" }`, `TAB_TITLES`, `RATING_TEXT`)
 *   or a list of texts (`const SUGGESTION_TEXTS = ["What can you do?"]`),
 *   with the same exceptions.
 * - What a variable or function named for a text holds or returns (`const menuTitle = …`, `statusText(i)`), and the
 *   strings a file passes to its own functions' text parameters (`popular("1", "Most capitalized")`). A string written
 *   in pieces for the line length ("…as " + "columns…") is one text.
 * - The texts given to the translator: `translate("High")`, `translateDrawn(…)`, the template of
 *   `translateWith("{0} bars", n)` (both branches of a condition), the text of `translateAs("Close", "action")` with
 *   its sense, and the forms of `translatePlural(n, { one: "{0} bar", other: "{0} bars" })`.
 *
 * `joinedTexts` finds the interface text the code assembles from pieces ("Undo " + step): a translation needs the
 * whole phrase, so such text is written as a template for translateWith instead.
 */
import ts from "typescript";

export type PluralForms = { one: string; other: string };

export type StaticText = { text: string; file: string; line: number; sense?: string; plural?: PluralForms };

/** Attributes the translator translates. */
const ATTRIBUTES = new Set(["title", "placeholder"]);

/**
 * Fields of an object, and props of a component, whose string is shown to the user: a menu row's `label`, a dialog's
 * `mainText`, a tab's `title`, a screen's `description` (not a symbol's: an object with a `ticker` is data). Not `name`
 * or `message`: script and tool definitions, alert messages the user edits.
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
  // A column's or a metric's short title ("Mkt cap").
  "short",
  "cancelText",
  "closeLabel",
  "menuLabel",
  "note",
  "description",
]);

/** Fields of an object holding a symbol: its description is data, not interface text. */
const SYMBOL_FIELDS = new Set(["ticker", "symbolName"]);

/**
 * A variable, function or parameter named for the text it holds or returns: `label`, `menuTitle`, `tip`,
 * `statusText`. Its shown strings are read (the branches of a condition, what an arrow function or a `return` gives),
 * and for a parameter the strings given to it by the calls in the same file (`popular("1", "Most capitalized")`).
 */
const TEXT_NAME = /^(?:label|title|short|text|tip|tooltip|caption|message|description)s?$|[a-z0-9](?:Label|Title|Text|Tip|Tooltip|Caption|Message|Description)s?$/;

/** A component's prop listing the choices it shows. */
const OPTIONS = "options";

/** A constant mapping ids to what is shown for them: `TYPE_LABEL`, `TAB_TITLES`, `RATING_TEXT`. */
const TEXT_MAP = /(?:^|_)(?:LABEL|TITLE|TEXT)S?$/;

/** A value that names something for the code, not the user: `"1d"`, `"#2962ff"`. */
const ID_LIKE = /^(?:[0-9][a-z0-9_.:/-]*|#[0-9a-fA-F]{3,8})$/;

/** A field value starting in lowercase: an id, not a text. */
const FRAGMENT = /^[a-z]/;

/** The translator's functions taking a text (or a template) as their first argument. */
const TRANSLATOR_CALLS = new Set(["translate", "translateDrawn", "translateWith", "translateAs"]);

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

/** The expressions a shown expression can evaluate to as it is written: itself, or the branches of `?:`, `&&`, `||`, `??`. */
function shownLeaves(e: ts.Expression): ts.Expression[] {
  if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e)) return shownLeaves(e.expression);
  if (ts.isConditionalExpression(e)) return [...shownLeaves(e.whenTrue), ...shownLeaves(e.whenFalse)];
  // A text given as a function: `title: () => "Strategy vs benchmark"`, `label={(m) => (m === "count" ? "Count" : "Amount")}`.
  if (ts.isArrowFunction(e) && !ts.isBlock(e.body)) return shownLeaves(e.body);
  if (ts.isBinaryExpression(e)) {
    const op = e.operatorToken.kind;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) return shownLeaves(e.right);
    if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) return [...shownLeaves(e.left), ...shownLeaves(e.right)];
  }
  return [e];
}

/** A string written in pieces for the line length ("…its plots as " + "columns…"), as one text; undefined otherwise. */
function constantText(e: ts.Expression): string | undefined {
  if (ts.isStringLiteralLike(e)) return e.text;
  if (ts.isParenthesizedExpression(e)) return constantText(e.expression);
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const [a, b] = [constantText(e.left), constantText(e.right)];
    return a !== undefined && b !== undefined ? a + b : undefined;
  }
  return undefined;
}

/** The strings a shown expression can evaluate to as it is written, each with the expression writing it. */
function shownStrings(e: ts.Expression): { text: string; node: ts.Expression }[] {
  return shownLeaves(e).flatMap((node) => {
    const text = constantText(node);
    return text === undefined ? [] : [{ text, node }];
  });
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

/** A constant listing a select's choices: `SESSION_OPTIONS`. */
const OPTIONS_LIST = /_OPTIONS$/;

/** The array a constant of the file holds (`const SESSION_OPTIONS = ["Regular", "Extended"]`). */
function optionsList(sf: ts.SourceFile, name: string): ts.Expression | undefined {
  let found: ts.Expression | undefined;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name && n.initializer) found = n.initializer;
    else ts.forEachChild(n, visit);
  };
  visit(sf);
  while (found && (ts.isAsExpression(found) || ts.isSatisfiesExpression(found) || ts.isParenthesizedExpression(found))) found = found.expression;
  return found;
}

/** The name of the function called (`translateWith`, `i18n.translateWith`). */
function calleeName(e: ts.CallExpression): string | undefined {
  const callee = ts.isPropertyAccessExpression(e.expression) ? e.expression.name : e.expression;
  return ts.isIdentifier(callee) ? callee.text : undefined;
}

/** `{ one: "{0} bar", other: "{0} bars" }`: the forms of a plural, both written out. */
export function pluralForms(e: ts.Node): PluralForms | undefined {
  if (!ts.isObjectLiteralExpression(e) || e.properties.length !== 2) return undefined;
  const forms: Record<string, string> = {};
  for (const p of e.properties) {
    if (!ts.isPropertyAssignment(p) || !ts.isStringLiteralLike(p.initializer)) return undefined;
    forms[propertyName(p.name) ?? ""] = p.initializer.text;
  }
  return forms.one !== undefined && forms.other !== undefined ? { one: forms.one, other: forms.other } : undefined;
}

/** An object literal describing a symbol (it has a `ticker`). */
function isSymbol(obj: ts.Node): boolean {
  return ts.isObjectLiteralExpression(obj) && obj.properties.some((p) => SYMBOL_FIELDS.has(p.name && ts.isIdentifier(p.name) ? p.name.text : ""));
}

/** The functions of a file taking a text: their name and the positions of their text parameters. */
function textParameters(sf: ts.SourceFile): Map<string, number[]> {
  const out = new Map<string, number[]>();
  const note = (name: ts.Node | undefined, fn: ts.SignatureDeclarationBase) => {
    if (!name || !ts.isIdentifier(name)) return;
    const at = fn.parameters.flatMap((p, i) => (ts.isIdentifier(p.name) && TEXT_NAME.test(p.name.text) ? [i] : []));
    if (at.length) out.set(name.text, at);
  };
  const visit = (n: ts.Node) => {
    if (ts.isFunctionDeclaration(n)) note(n.name, n);
    else if (ts.isVariableDeclaration(n) && n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) note(n.name, n.initializer);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** What a text variable holds, or what a text function returns: the expressions its strings are read from. */
function returned(node: ts.VariableDeclaration | ts.FunctionDeclaration): ts.Expression[] {
  const fn = ts.isFunctionDeclaration(node) ? node : node.initializer;
  if (!fn) return [];
  if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn) && !ts.isFunctionDeclaration(fn)) return [fn as ts.Expression];
  if (fn.body && !ts.isBlock(fn.body)) return [fn.body];
  const out: ts.Expression[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isReturnStatement(n) && n.expression) out.push(n.expression);
    else if (!ts.isFunctionLike(n)) ts.forEachChild(n, visit);
  };
  if (fn.body) ts.forEachChild(fn.body, visit);
  return out;
}

function parse(file: string, source: string): ts.SourceFile {
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

/** What a JSX attribute holds: the string, or the expression in braces. */
function attributeValue(node: ts.JsxAttribute): ts.Expression | undefined {
  const init = node.initializer;
  return init && ts.isStringLiteral(init) ? init : init && ts.isJsxExpression(init) ? init.expression : undefined;
}

/**
 * Where a file shows text: each expression whose strings reach the page, `all` when every string is shown (a JSX
 * child, a translated attribute), not `all` when ids and lowercase values are left out (fields, props, text names).
 */
function visitShown(sf: ts.SourceFile, onShown: (e: ts.Expression, all: boolean) => void, onNode: (n: ts.Node) => void = () => {}): void {
  const textParams = textParameters(sf);
  const visit = (node: ts.Node) => {
    onNode(node);
    if (ts.isJsxExpression(node) && node.expression && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) onShown(node.expression, true);
    else if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(sf);
      const value = attributeValue(node);
      const component = isComponent(node.parent.parent.tagName, sf);
      if (value && ATTRIBUTES.has(name)) onShown(value, true);
      else if (value && TEXT_FIELDS.has(name) && component) onShown(value, false);
      else if (value && name === OPTIONS && component && ts.isArrayLiteralExpression(value)) for (const v of value.elements) onShown(v, false);
    } else if (ts.isPropertyAssignment(node) && TEXT_FIELDS.has(propertyName(node.name) ?? "") && !isSymbol(node.parent)) onShown(node.initializer, false);
    else if (ts.isPropertyAssignment(node) && propertyName(node.name) === OPTIONS) {
      // A select's choices: `options: ["Left", "Right"]`, or a list of the file named for them (`VISIBILITY_OPTIONS`).
      const list = ts.isIdentifier(node.initializer) && OPTIONS_LIST.test(node.initializer.text) ? optionsList(sf, node.initializer.text) : node.initializer;
      if (list && ts.isArrayLiteralExpression(list)) for (const v of list.elements) onShown(v, false);
    }
    else if (ts.isArrayLiteralExpression(node) && inTextMap(node)) for (const v of node.elements) onShown(v, false);
    else if (ts.isPropertyAssignment(node) && inTextMap(node.parent)) {
      // A pair ("Annual", "FY") is two texts.
      const values = ts.isArrayLiteralExpression(node.initializer) ? node.initializer.elements : [node.initializer];
      for (const v of values) onShown(v, false);
    } else if ((ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node)) && node.name && ts.isIdentifier(node.name) && TEXT_NAME.test(node.name.text)) {
      for (const e of returned(node)) onShown(e, false);
    } else if (ts.isCallExpression(node)) {
      const params = textParams.get(calleeName(node) ?? "");
      if (params) for (const i of params) if (node.arguments[i]) onShown(node.arguments[i], false);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

export function staticTexts(file: string, source: string): StaticText[] {
  const sf = parse(file, source);
  const out: StaticText[] = [];
  const lineOf = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const add = (text: string, node: ts.Node, sense = senseOf(node, sf)) => {
    const t = text.trim();
    if (!t) return;
    out.push({ text: t, file, line: lineOf(node), ...(sense ? { sense } : {}) });
  };
  visitShown(
    sf,
    (e, all) => {
      for (const s of shownStrings(e)) if (all || (!ID_LIKE.test(s.text) && !FRAGMENT.test(s.text))) add(s.text, s.node);
    },
    (node) => {
      if (ts.isJsxText(node)) add(jsxText(node.text), node);
      else if (ts.isCallExpression(node) && node.arguments[0]) {
        const call = calleeName(node);
        const [first, second] = node.arguments;
        if (call && TRANSLATOR_CALLS.has(call)) {
          const sense = call === "translateAs" && second && ts.isStringLiteralLike(second) ? second.text : undefined;
          for (const s of shownStrings(first)) add(s.text, s.node, sense);
        } else if (call === "translatePlural" && second) {
          const forms = pluralForms(second);
          if (forms) out.push({ text: forms.other, file, line: lineOf(second), plural: forms });
        }
      }
    },
  );
  return out;
}

export type JoinedText = { file: string; line: number; code: string };

/**
 * The written part of a joined text holds a word: two letters, one in lowercase, capitalized or in a part with a space
 * ("Undo ", " bars ago", "Exit"). `${n}`, `${a} · ${b}`, `${x}%`, `${n} MB`, `UTC${sign}` and an id's `chart-${n}`
 * hold none.
 */
function hasWord(part: string): boolean {
  const words = part.match(/[A-Za-z]{2,}/g) ?? [];
  return words.some((w) => /[a-z]/.test(w) && (/\s/.test(part) || /^[A-Z]/.test(w)));
}

/** The written parts of a text joined from pieces and values, undefined when the expression is not one. */
function writtenParts(e: ts.Expression): string[] | undefined {
  if (constantText(e) !== undefined) return undefined;
  if (ts.isTemplateExpression(e)) return [e.head.text, ...e.templateSpans.map((s) => s.literal.text)];
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const sides = [e.left, e.right].map((s) => (ts.isParenthesizedExpression(s) ? s.expression : s));
    const parts = sides.flatMap((s) => (ts.isStringLiteralLike(s) ? [s.text] : (writtenParts(s) ?? [])));
    // `a + b` with no string on either side is arithmetic.
    return sides.some((s) => ts.isStringLiteralLike(s) || ts.isTemplateExpression(s) || writtenParts(s)) ? parts : undefined;
  }
  return undefined;
}

/** A JSX child shows an element, or nothing: not a value written into the text around it. */
function showsElement(e: ts.Expression): boolean {
  return shownLeaves(e).every(
    (l) =>
      ts.isJsxElement(l) ||
      ts.isJsxSelfClosingElement(l) ||
      ts.isJsxFragment(l) ||
      l.kind === ts.SyntaxKind.NullKeyword ||
      l.kind === ts.SyntaxKind.FalseKeyword ||
      (ts.isIdentifier(l) && l.text === "undefined") ||
      // `{list.map((x) => <Row />)}`, `{props.children}`
      (ts.isCallExpression(l) && ts.isPropertyAccessExpression(l.expression) && l.expression.name.text === "map") ||
      (ts.isPropertyAccessExpression(l) && l.name.text === "children"),
  );
}

/**
 * JSX text and values side by side in an element (`{n} found it useful`, `Showing {a} of {b}`): the page holds the
 * words and the values as separate texts, each translated alone.
 */
function jsxJoined(sf: ts.SourceFile): ts.Node[][] {
  const out: ts.Node[][] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node) || ts.isJsxFragment(node)) {
      // The runs of text and expressions between the child elements.
      let run: ts.Node[] = [];
      const close = () => {
        const words = run.some((c) => ts.isJsxText(c) && hasWord(c.text.replace(/\s+/g, " ")));
        const values = run.some((c) => ts.isJsxExpression(c) && c.expression && constantText(c.expression) === undefined && !showsElement(c.expression));
        if (words && values) out.push(run);
        run = [];
      };
      for (const c of node.children) {
        if (ts.isJsxText(c) || (ts.isJsxExpression(c) && !(c.expression && showsElement(c.expression)))) run.push(c);
        else close();
      }
      close();
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/**
 * Interface text joined from words and values (`"Undo " + name`, `` `${n} decimals` ``, JSX's `{n} found it useful`),
 * where the static text is read: a translation needs the whole phrase.
 */
export function joinedTexts(file: string, source: string): JoinedText[] {
  const sf = parse(file, source);
  const out: JoinedText[] = [];
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  visitShown(sf, (e) => {
    for (const leaf of shownLeaves(e)) {
      const parts = writtenParts(leaf);
      if (parts?.some(hasWord)) out.push({ file, line: lineOf(leaf), code: leaf.getText(sf).replace(/\s+/g, " ").slice(0, 120) });
    }
  });
  for (const run of jsxJoined(sf)) {
    const code = run.map((c) => (ts.isJsxText(c) ? c.text : c.getText(sf))).join("").replace(/\s+/g, " ").trim();
    out.push({ file, line: lineOf(run.find((c) => !ts.isJsxText(c) || c.text.trim()) ?? run[0]), code: code.slice(0, 120) });
  }
  return out.sort((a, b) => a.line - b.line);
}
