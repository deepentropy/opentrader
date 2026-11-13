/*
 * Profiler mode (#312): the source of a script with a timer around each statement, so a run tells how long each line
 * took and how many times it ran.
 *
 * Every statement of the script (the top level and the bodies of its functions and callbacks) gets a span: its first
 * line, and its last one when it holds other spans (a loop, an `if`, a statement whose callback has statements: a code
 * block). The code only gains text inside lines, never a line break, so the lines of the script stay where they were
 * (error positions too). The timers are calls on the global PROFILE_GLOBAL, set by the worker before each run:
 *  - an expression (an expression statement, a declaration's value, a returned or thrown value) becomes
 *    `P.x(id, P.n(), (expr))`, its time from before to after it (`P.y` for the values after the first one of a
 *    declaration: one execution per statement);
 *  - a compound statement (loop, if, switch, try, block, labelled) goes in `{ const t = P.n(); try { … } finally {
 *    P.b(id, t); } }`, which keeps break / continue / return working and declares nothing outside it.
 * Declarations of functions and classes and the import / export lines are left as they are (their bodies are timed).
 */
import { parse, type Node } from "acorn";

/** The name of the run's profile on the worker's global object. */
export const PROFILE_GLOBAL = "__oakProfile";

/** The lines of a span: its first line, and its last one when it is a code block. */
export type SpanLines = [number] | [number, number];

export type Instrumented = { code: string; spans: SpanLines[] };

type AnyNode = Node & Record<string, unknown>;

/** Code to put at an offset of the source; `order` keeps the pieces put at one offset in a nesting order. */
type Insert = { at: number; code: string; order: number };

const P = PROFILE_GLOBAL;

/** Line (1-based) of each offset, from the line starts. */
function lineIndex(source: string): (offset: number) => number {
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source.charCodeAt(i) === 10) starts.push(i + 1);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

const isNode = (v: unknown): v is AnyNode => !!v && typeof v === "object" && typeof (v as { type?: unknown }).type === "string";

/** The child nodes of `node`, in source order. */
function children(node: AnyNode): AnyNode[] {
  const out: AnyNode[] = [];
  for (const key of Object.keys(node)) {
    if (key === "type" || key === "start" || key === "end" || key === "loc" || key === "range") continue;
    const v = node[key];
    if (Array.isArray(v)) {
      for (const x of v) if (isNode(x)) out.push(x);
    } else if (isNode(v)) out.push(v);
  }
  return out.sort((a, b) => a.start - b.start);
}

const COMPOUND = new Set([
  "IfStatement",
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
  "WhileStatement",
  "DoWhileStatement",
  "SwitchStatement",
  "TryStatement",
  "BlockStatement",
  "LabeledStatement",
]);

const FUNCTION = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);

/**
 * The script `source` with its timers, and its spans (indexed by the ids in the timers). Throws the parser's
 * SyntaxError when the source does not parse (the caller compiles it as it is then, for the error of the engine).
 */
export function instrumentSource(source: string): Instrumented {
  const program = parse(source, {
    ecmaVersion: "latest",
    sourceType: "module",
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
    allowHashBang: true,
  }) as unknown as AnyNode;
  const lineOf = lineIndex(source);
  const spans: SpanLines[] = [];
  const inserts: Insert[] = [];
  let order = 0;
  const put = (at: number, code: string) => inserts.push({ at, code, order: order++ });

  /** A span for `node`; its last line is set later when it holds other spans. */
  const span = (node: AnyNode): number => {
    spans.push([lineOf(node.start)]);
    return spans.length - 1;
  };
  /** Makes the spans inside span `id` (of `node`): `id` becomes a code block when there are some. */
  const within = (id: number, node: AnyNode, fn: () => void) => {
    const before = spans.length;
    fn();
    if (spans.length > before) {
      const first = spans[id][0];
      const last = lineOf(Math.max(node.start, node.end - 1));
      if (last > first) spans[id] = [first, last];
    }
  };

  /** Time expression `e` as span `id` (counted: one execution). */
  const timeExpression = (e: AnyNode, id: number, counted = true) => {
    put(e.start, `${P}.${counted ? "x" : "y"}(${id}, ${P}.n(), (`);
    within(id, e, () => walk(e));
    put(e.end, "))");
  };

  /** Statements of a list (a body, a block, a switch case): each one timed. */
  const statements = (list: AnyNode[]) => {
    for (const s of list) statement(s);
  };

  const statement = (s: AnyNode): void => {
    switch (s.type) {
      case "ImportDeclaration":
      case "ExportAllDeclaration":
      case "EmptyStatement":
      case "BreakStatement":
      case "ContinueStatement":
      case "DebuggerStatement":
        return;
      case "ExportNamedDeclaration":
      case "ExportDefaultDeclaration": {
        const d = s.declaration as AnyNode | null;
        if (!d) return;
        if (d.type === "VariableDeclaration" || FUNCTION.has(d.type) || d.type === "ClassDeclaration") statement(d);
        else walk(d);
        return;
      }
      case "FunctionDeclaration":
      case "ClassDeclaration":
        walk(s);
        return;
      case "VariableDeclaration": {
        // A function or class value is not timed (making it takes no time): it keeps the name of its variable.
        const timed = (init: AnyNode | null): init is AnyNode => !!init && !(FUNCTION.has(init.type) || init.type === "ClassExpression");
        if (!(s.declarations as AnyNode[]).some((d) => timed(d.init as AnyNode | null))) {
          walk(s);
          return;
        }
        const id = span(s);
        let first = true;
        within(id, s, () => {
          for (const d of s.declarations as AnyNode[]) {
            walk(d.id as AnyNode);
            const init = d.init as AnyNode | null;
            if (!timed(init)) {
              if (init) walk(init);
              continue;
            }
            timeExpression(init, id, first);
            first = false;
          }
        });
        return;
      }
      case "ExpressionStatement": {
        if (typeof s.directive === "string") return;
        timeExpression(s.expression as AnyNode, span(s));
        return;
      }
      case "ReturnStatement":
      case "ThrowStatement": {
        const arg = s.argument as AnyNode | null;
        if (arg) timeExpression(arg, span(s));
        return;
      }
      default: {
        if (!COMPOUND.has(s.type)) {
          walk(s);
          return;
        }
        const id = span(s);
        const t = `__t${id}`;
        put(s.start, `{ const ${t} = ${P}.n(); try { `);
        within(id, s, () => body(s));
        put(s.end, ` } finally { ${P}.b(${id}, ${t}); } }`);
      }
    }
  };

  /** The parts of a compound statement: the statements of its blocks timed, its expressions walked for functions. */
  const body = (s: AnyNode) => {
    if (s.type === "BlockStatement") {
      statements(s.body as AnyNode[]);
      return;
    }
    if (s.type === "SwitchStatement") {
      walk(s.discriminant as AnyNode);
      for (const c of s.cases as AnyNode[]) {
        if (c.test) walk(c.test as AnyNode);
        statements(c.consequent as AnyNode[]);
      }
      return;
    }
    if (s.type === "TryStatement") {
      body(s.block as AnyNode);
      const handler = s.handler as AnyNode | null;
      if (handler) body(handler.body as AnyNode);
      if (s.finalizer) body(s.finalizer as AnyNode);
      return;
    }
    if (s.type === "LabeledStatement") {
      // the label stays on its loop: `continue label` needs it there
      body(s.body as AnyNode);
      return;
    }
    for (const c of children(s)) {
      const isBody = c === s.body || c === s.consequent || c === s.alternate;
      if (isBody && c.type !== "BlockStatement" && c.type !== "VariableDeclaration") statement(c);
      else if (isBody && c.type === "BlockStatement") statements(c.body as AnyNode[]);
      else walk(c);
    }
  };

  /** An expression or a pattern: the bodies of its functions are timed. */
  const walk = (n: AnyNode): void => {
    if (FUNCTION.has(n.type)) {
      for (const p of n.params as AnyNode[]) walk(p);
      const b = n.body as AnyNode;
      if (b.type === "BlockStatement") statements(b.body as AnyNode[]);
      else walk(b);
      return;
    }
    if (n.type === "StaticBlock") {
      statements(n.body as AnyNode[]);
      return;
    }
    for (const c of children(n)) walk(c);
  };

  statements(program.body as AnyNode[]);

  // Texts put at one offset: the ones closing a span first (inner, in reverse order), then the opening ones.
  inserts.sort((a, b) => a.at - b.at || a.order - b.order);
  let code = "";
  let last = 0;
  for (const ins of inserts) {
    code += source.slice(last, ins.at) + ins.code;
    last = ins.at;
  }
  code += source.slice(last);
  return { code, spans };
}
