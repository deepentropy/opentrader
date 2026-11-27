/*
 * Formula symbols ("spreads"): symbols combined with numbers by + - * / ^ and
 * parentheses, as the symbol search, the watchlist and an uploaded list take
 * them ("AAPL/MSFT", "(NASDAQ:AAPL+NASDAQ:MSFT)/2", "2*AAPL-MSFT").
 *
 * The reference app's rules, measured on its charts (27/11/2026, .tmp/spread-symbols):
 *  - each bar applies the formula to the legs' opens, highs, lows and closes in
 *    turn; the bar's high and low are the highest and lowest of those four;
 *  - its volume is the sum of the legs' volumes;
 *  - its times are those of every leg: a leg without a bar at a time counts its
 *    last close;
 *  - weekly and monthly bars aggregate the daily formula bars.
 * A name holding an operator is written between quotes ('BAC/PB').
 *
 * A symbol's identity is its full name, so a stored formula names every leg in
 * full ("NASDAQ:AAPL/NASDAQ:MSFT"): {@link normalizeSpread} turns what was
 * typed into that form.
 */
import type { Candle } from "../bindings";

export type TokenType =
  | "symbol"
  | "number"
  | "open"
  | "close"
  | "plus"
  | "minus"
  | "multiply"
  | "divide"
  | "power"
  | "space"
  | "unparsed";

export type Token = { type: TokenType; value: string; offset: number };

/** A symbol, or a quoted name. A symbol runs over letters, digits and `_ . : ! & |` (an operator or a space ends it). */
const SYMBOL = /'[^']*'?|[A-Za-z0-9_Ͱ-῿⺀-￿][A-Za-z0-9_Ͱ-῿⺀-￿!|:.&]*/y;
/** A number, unless a symbol goes on after its digits ("4DS", "3M"). */
const NUMBER = /\d+(?:\.\d*|(?![A-Za-z0-9_!:.&]))|\.\d+/y;
const SPACE = /\s+/y;
const SIGNS: Record<string, TokenType> = {
  "(": "open",
  ")": "close",
  "+": "plus",
  "-": "minus",
  "*": "multiply",
  "/": "divide",
  "^": "power",
};

/** The tokens of a formula, spaces included. */
export function tokenize(text: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const take = (re: RegExp, type: TokenType): boolean => {
    re.lastIndex = i;
    const m = re.exec(text);
    if (!m || !m[0]) return false;
    out.push({ type, value: m[0], offset: i });
    i += m[0].length;
    return true;
  };
  while (i < text.length) {
    const sign = SIGNS[text[i]];
    if (sign) {
      out.push({ type: sign, value: text[i], offset: i });
      i++;
      continue;
    }
    if (take(SPACE, "space") || take(NUMBER, "number") || take(SYMBOL, "symbol")) continue;
    out.push({ type: "unparsed", value: text[i], offset: i });
    i++;
  }
  return out;
}

const isOperator = (t: TokenType) => t === "plus" || t === "minus" || t === "multiply" || t === "divide" || t === "power";

/** A name written between quotes, without them. */
export function unquote(name: string): string {
  return name.startsWith("'") ? name.replace(/^'|'$/g, "") : name;
}

/** A name holding an operator is written between quotes. */
export const NEEDS_QUOTES = /[+\-/*^()\s]/;
const quoted = (name: string) => (NEEDS_QUOTES.test(name) ? `'${name}'` : name);

/** A stored symbol that is one listing even with a `/` or `-` in its ticker: a share class ("NYSE:BAC/PB",
 *  "NYSE:BRK-B"), an imported series ("LOCAL:BTC-2") or an economic series. */
const ONE_LISTING = /^(?:(?:LOCAL|ECONOMICS):[A-Z0-9._-]+|[A-Z0-9_]+:[A-Z0-9]+(?:[./-][A-Z]+)*)$/i;

/** True for a formula: a symbol or a number combined by an operator with another. Read like the reference: an
 *  operator inside a name needs quotes, but a stored full name of one listing ({@link ONE_LISTING}) stays one. */
export function isSpreadSymbol(symbol: string | null | undefined): boolean {
  if (!symbol) return false;
  const s = symbol.trim();
  if (!s || ONE_LISTING.test(s)) return false;
  const tokens = tokenize(s).filter((t) => t.type !== "space");
  return tokens.length > 1 && tokens.some((t) => isOperator(t.type));
}

// ── Parse and evaluate ─────────────────────────────────────────────────────

export type SpreadNode =
  | { kind: "number"; value: number }
  | { kind: "symbol"; name: string }
  | { kind: "negate"; arg: SpreadNode }
  | { kind: "binary"; op: "+" | "-" | "*" | "/" | "^"; left: SpreadNode; right: SpreadNode };

/** The formula's tree, or null when it does not read: an unknown sign, a missing operand or parenthesis, an
 *  unclosed quote. `^` binds tightest (from the right), then `*` `/`, then `+` `-`; a sign may lead an operand. */
export function parseSpread(text: string): SpreadNode | null {
  const tokens = tokenize(text).filter((t) => t.type !== "space");
  let i = 0;
  const peek = () => tokens[i]?.type;
  function primary(): SpreadNode | null {
    const t = tokens[i];
    if (!t) return null;
    if (t.type === "number") {
      i++;
      return { kind: "number", value: Number(t.value) };
    }
    if (t.type === "symbol") {
      i++;
      if (t.value.startsWith("'") && (t.value.length < 2 || !t.value.endsWith("'"))) return null;
      const name = unquote(t.value).trim().toUpperCase();
      return name ? { kind: "symbol", name } : null;
    }
    if (t.type === "open") {
      i++;
      const e = sum();
      if (!e || peek() !== "close") return null;
      i++;
      return e;
    }
    return null;
  }
  function unary(): SpreadNode | null {
    if (peek() === "minus" || peek() === "plus") {
      const neg = peek() === "minus";
      i++;
      const arg = unary();
      return arg && (neg ? { kind: "negate", arg } : arg);
    }
    return power();
  }
  function power(): SpreadNode | null {
    const base = primary();
    if (!base || peek() !== "power") return base;
    i++;
    const exp = unary();
    return exp && { kind: "binary", op: "^", left: base, right: exp };
  }
  function product(): SpreadNode | null {
    let left = unary();
    while (left && (peek() === "multiply" || peek() === "divide")) {
      const op = peek() === "multiply" ? "*" : "/";
      i++;
      const right = unary();
      left = right && { kind: "binary", op, left, right };
    }
    return left;
  }
  function sum(): SpreadNode | null {
    let left = product();
    while (left && (peek() === "plus" || peek() === "minus")) {
      const op = peek() === "plus" ? "+" : "-";
      i++;
      const right = product();
      left = right && { kind: "binary", op, left, right };
    }
    return left;
  }
  const tree = sum();
  return tree && i === tokens.length ? tree : null;
}

/** The legs of a formula: its symbols, once each, in their order (upper case, without quotes). */
export function spreadLegs(symbol: string): string[] {
  const out: string[] = [];
  for (const t of tokenize(symbol)) {
    if (t.type !== "symbol") continue;
    const name = unquote(t.value).trim().toUpperCase();
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/** The formula's value for the legs' values; NaN when a leg has none or a value is not a number (a division by
 *  zero). */
export function evaluateSpread(node: SpreadNode, value: (leg: string) => number | undefined): number {
  switch (node.kind) {
    case "number":
      return node.value;
    case "symbol":
      return value(node.name) ?? NaN;
    case "negate":
      return -evaluateSpread(node.arg, value);
    case "binary": {
      const a = evaluateSpread(node.left, value);
      const b = evaluateSpread(node.right, value);
      const r = node.op === "+" ? a + b : node.op === "-" ? a - b : node.op === "*" ? a * b : node.op === "/" ? a / b : a ** b;
      return Number.isFinite(r) ? r : NaN;
    }
  }
}

// ── Names ──────────────────────────────────────────────────────────────────

/** The formula written again with each leg renamed: no spaces, a name holding an operator between quotes. */
export function renameLegs(symbol: string, rename: (leg: string) => string): string {
  return tokenize(symbol)
    .filter((t) => t.type !== "space")
    .map((t) => (t.type === "symbol" ? quoted(rename(unquote(t.value).trim().toUpperCase())) : t.value))
    .join("");
}

/** The formula as the app keeps it: upper case, no spaces, every leg's full name ("aapl / msft" →
 *  "NASDAQ:AAPL/NASDAQ:MSFT"). Null when it does not read or a leg has no listing. */
export async function normalizeSpread(text: string, fullName: (leg: string) => Promise<string>): Promise<string | null> {
  if (!parseSpread(text)) return null;
  const legs = spreadLegs(text);
  try {
    const full = await Promise.all(legs.map((l) => fullName(l)));
    const byLeg = new Map(legs.map((l, k) => [l, full[k].toUpperCase()]));
    return renameLegs(text, (l) => byLeg.get(l) ?? l);
  } catch {
    return null;
  }
}

/** The formula with its legs' tickers only, as charts, rows and tabs show it ("NASDAQ:AAPL/NASDAQ:MSFT" →
 *  "AAPL/MSFT"). */
export function spreadShortName(symbol: string): string {
  return renameLegs(symbol, (leg) => leg.slice(leg.indexOf(":") + 1));
}

// ── Bars ───────────────────────────────────────────────────────────────────

const FIELDS = ["open", "high", "low", "close"] as const;

/** The formula's bars from its legs' (`legBars[k]` = bars of `legs[k]`, oldest first): one bar at each time of any
 *  leg once every leg has a bar; a leg without a bar at that time counts its last close. A bar whose value is not a
 *  number (a division by zero) is left out. */
export function combineSpreadBars(tree: SpreadNode, legs: string[], legBars: Candle[][]): Candle[] {
  const times = new Set<number>();
  for (const bars of legBars) for (const b of bars) if (b.time !== null) times.add(b.time);
  const sorted = [...times].sort((a, b) => a - b);
  const at = legBars.map(() => -1);
  const out: Candle[] = [];
  const current = new Map<string, Candle>();
  for (const time of sorted) {
    let volume = 0;
    let started = true;
    legs.forEach((leg, k) => {
      const bars = legBars[k];
      while (at[k] + 1 < bars.length && (bars[at[k] + 1].time ?? Infinity) <= time) at[k]++;
      const b = at[k] >= 0 ? bars[at[k]] : undefined;
      if (!b) {
        started = false;
        return;
      }
      if (b.time === time) {
        current.set(leg, b);
        volume += b.volume ?? 0;
      } else {
        current.set(leg, { time, open: b.close, high: b.close, low: b.close, close: b.close, volume: 0 });
      }
    });
    if (!started) continue;
    const bar = spreadBar(tree, time, (leg) => current.get(leg), volume);
    if (bar) out.push(bar);
  }
  return out;
}

/** One formula bar from one bar of each leg (see the file's header), or null when a value is not a number. */
export function spreadBar(tree: SpreadNode, time: number, legBar: (leg: string) => Candle | undefined, volume: number): Candle | null {
  const v = FIELDS.map((f) => evaluateSpread(tree, (leg) => legBar(leg)?.[f] ?? undefined));
  if (v.some((x) => Number.isNaN(x))) return null;
  return { time, open: v[0], high: Math.max(...v), low: Math.min(...v), close: v[3], volume };
}

/** True when the formula is a price in its legs' currency: the reference names one for a sum, a difference or a
 *  multiple of prices (and a power), none once a price is divided or multiplied by another. */
export function spreadKeepsCurrency(tree: SpreadNode): boolean {
  const degree = (n: SpreadNode): number => {
    switch (n.kind) {
      case "number":
        return 0;
      case "symbol":
        return 1;
      case "negate":
        return degree(n.arg);
      case "binary":
        if (n.op === "/") return NaN;
        if (n.op === "*") return degree(n.left) + degree(n.right);
        if (n.op === "^") return degree(n.left);
        return Math.max(degree(n.left), degree(n.right));
    }
  };
  return degree(tree) === 1;
}

/** A leg's quote: its last price and its change from the close before. */
export type LegQuote = { last: number | null; change: number | null };

/** The formula's last price and change from its legs' quotes: the formula of the last prices against the formula
 *  of the closes before. Null when a leg has no price. */
export function spreadQuote(tree: SpreadNode, quote: (leg: string) => LegQuote | undefined): { last: number; change: number; changePercent: number } | null {
  const last = evaluateSpread(tree, (leg) => quote(leg)?.last ?? undefined);
  const prev = evaluateSpread(tree, (leg) => {
    const q = quote(leg);
    return q?.last == null ? undefined : q.last - (q.change ?? 0);
  });
  if (Number.isNaN(last) || Number.isNaN(prev)) return null;
  const change = last - prev;
  return { last, change, changePercent: prev ? (change / Math.abs(prev)) * 100 : 0 };
}

/** A live bar as the datafeed buckets it (datafeed's LiveBar). */
export type SpreadLiveBar = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  dayTime?: number;
  volumeIsIncrement?: boolean;
};

/** The live bars of a charted formula from its legs' live bars: each leg's forming bar merges its ticks, a leg
 *  without a bar at that time counts its last close (`lastClose` before its first live bar), and the formula's bar is
 *  {@link spreadBar} of them. */
export class SpreadLiveBars {
  private symbol = "";
  private tree: SpreadNode | null = null;
  private legs: string[] = [];
  private forming = new Map<string, SpreadLiveBar>();

  constructor(private readonly lastClose: (leg: string) => number | undefined) {}

  /** True when `leg` is a leg of the formula `symbol`. */
  hasLeg(symbol: string, leg: string): boolean {
    this.follow(symbol);
    return !!this.tree && this.legs.includes(leg);
  }

  /** The formula's bar after one of its legs' live bars; null when it is not a leg, is older than that leg's forming
   *  bar, or a leg has no price yet. */
  update(symbol: string, leg: string, bar: SpreadLiveBar): SpreadLiveBar | null {
    if (!this.hasLeg(symbol, leg) || !this.tree) return null;
    const cur = this.forming.get(leg);
    if (cur && bar.time < cur.time) return null;
    const merged: SpreadLiveBar =
      cur && cur.time === bar.time
        ? {
            ...bar,
            open: cur.open,
            high: Math.max(cur.high, bar.high),
            low: Math.min(cur.low, bar.low),
            volume: bar.volumeIsIncrement ? cur.volume + bar.volume : Math.max(cur.volume, bar.volume),
          }
        : bar;
    this.forming.set(leg, merged);
    let volume = 0;
    const legBar = (l: string): Candle | undefined => {
      const f = this.forming.get(l);
      if (f && f.time === bar.time) return f;
      const close = f ? f.close : this.lastClose(l);
      return close === undefined ? undefined : { time: bar.time, open: close, high: close, low: close, close, volume: 0 };
    };
    for (const l of this.legs) {
      const f = this.forming.get(l);
      if (f && f.time === bar.time) volume += f.volume;
    }
    const out = spreadBar(this.tree, bar.time, legBar, volume);
    if (!out) return null;
    return { time: bar.time, open: out.open!, high: out.high!, low: out.low!, close: out.close!, volume, dayTime: bar.dayTime };
  }

  private follow(symbol: string): void {
    if (symbol === this.symbol) return;
    this.symbol = symbol;
    this.tree = isSpreadSymbol(symbol) ? parseSpread(symbol) : null;
    this.legs = this.tree ? spreadLegs(symbol) : [];
    this.forming.clear();
  }
}

/** The symbol or number of a formula under the caret (ends inclusive), the one the symbol search looks up and a
 *  picked row replaces. */
export function spreadTokenAt(text: string, pos: number): { value: string; offset: number; name: string } | null {
  for (const t of tokenize(text)) {
    if ((t.type === "symbol" || t.type === "number") && t.offset <= pos && pos <= t.offset + t.value.length) {
      return { value: t.value, offset: t.offset, name: unquote(t.value).trim().toUpperCase() };
    }
  }
  return null;
}

/** The operator buttons of the symbol search, in the reference's order: [sign, name]. */
export const SPREAD_OPERATORS = [
  ["/", "Division"],
  ["-", "Subtraction"],
  ["+", "Addition"],
  ["*", "Multiplication"],
  ["^", "Exponentiation"],
] as const;

/** A formula after an operator button at the caret: the sign goes in after an operand (none after another operator,
 *  an opening parenthesis or at the start, as in the reference); "1/" (Reciprocal) goes before the operand under the
 *  caret. Null when nothing goes in. */
export function insertOperator(text: string, caret: number, sign: string): { text: string; caret: number } | null {
  if (sign === "1/") {
    const tok = spreadTokenAt(text, caret);
    const at = tok ? tok.offset : caret;
    return { text: text.slice(0, at) + "1/" + text.slice(at), caret: caret + 2 };
  }
  const before = text.slice(0, caret).trimEnd();
  if (!before || /[-+*/^(]$/.test(before)) return null;
  return { text: text.slice(0, caret) + sign + text.slice(caret), caret: caret + sign.length };
}
