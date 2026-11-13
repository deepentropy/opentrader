/*
 * Sessions of each symbol, as the data provider reports them
 * (`get_symbol_session`): the exchange time zone, the regular and extended
 * schedules, pre/post-market parts and holidays. Every session-dependent view
 * (RTH filter, session-anchored bars, countdown, pre/post tint, market status,
 * the "Exchange" time zone) reads the session of its own symbol here, so two
 * charts on different exchanges each follow their market.
 *
 * Resolved once per symbol and cached for the app run. `sessionsVersion()` is
 * a Solid signal bumped on every resolve, for views that render before their
 * symbol's session is known.
 */
import { createSignal } from "solid-js";
import { commands, type SymbolSession } from "../../bindings";
import { splitSymbol } from "../symbol-name";
import { SessionSpec } from "./spec";
import { isLocalSymbol, localSession } from "../local-series";

/** Bottom-bar session choice: regular hours or the extended (whole traded)
 *  day. */
export type SessionId = "RTH" | "ETH";

/** Market state at a time: in the regular session, pre- or post-market, or
 *  closed. */
export type MarketSession = "open" | "pre" | "post" | "closed";

/** A schedule as scripts take it: hours, corrections ("<session>:<dates>;dayoff:<dates>")
 *  and comma-separated holiday dates. */
export interface ScriptSession {
  session: string;
  corrections: string;
  holidays: string;
}

/** A symbol's schedules, parsed. */
export class SymbolSessions {
  readonly timeZone: string;
  readonly regular: SessionSpec;
  /** Whole traded day (regular when the symbol has no extended hours). */
  readonly extended: SessionSpec;
  readonly premarket: SessionSpec | null;
  readonly postmarket: SessionSpec | null;
  /** The symbol trades outside its regular session. */
  readonly hasExtendedHours: boolean;
  /** The regular and extended schedules with their corrections and holidays,
   *  for scripts: `time("D")`, `time_close`, `time_tradingday` and daily
   *  resampling follow early closes and special sessions off the weekly
   *  calendar only with these. */
  readonly regularScript: ScriptSession;
  readonly extendedScript: ScriptSession;
  /** Tick at the current price (minmov / pricescale): script
   *  `syminfo.mintick`, backtest fill rounding. */
  readonly mintick: number;
  /** The two terms of the tick (script `syminfo.minmove` / `syminfo.pricescale`). */
  readonly minmove: number;
  readonly pricescale: number;
  /** Tick bands [upper price bound, tick] ascending, the last bound
   *  Infinity; empty when the tick does not depend on the price. */
  readonly tickBands: ReadonlyArray<readonly [number, number]>;
  /** Interval ids served by the symbol's data plugin; empty for the provider's
   *  symbols (its capabilities say what it serves). */
  readonly intervals: readonly string[];

  constructor(info: SymbolSession) {
    const tz = info.timezone;
    const sub = (id: string) => info.subsessions.find((s) => s.id === id);
    const spec = (session: string, corrections: string) => new SessionSpec(tz, session, info.holidays, corrections);
    const ext = sub("extended");
    const pre = sub("premarket");
    const post = sub("postmarket");
    this.timeZone = tz;
    this.regularScript = { session: info.session, corrections: info.corrections, holidays: info.holidays };
    this.extendedScript = ext ? { session: ext.session, corrections: ext.corrections, holidays: info.holidays } : this.regularScript;
    this.regular = spec(info.session, info.corrections);
    this.extended = ext ? spec(ext.session, ext.corrections) : this.regular;
    this.premarket = pre ? spec(pre.session, pre.corrections) : null;
    this.postmarket = post ? spec(post.session, post.corrections) : null;
    this.hasExtendedHours = ext !== undefined && ext.session !== info.session;
    this.mintick = info.minmov / info.pricescale;
    this.minmove = info.minmov;
    this.pricescale = info.pricescale;
    const v = info.variableTickSize.trim().split(/\s+/).filter(Boolean).map(Number);
    const bands: [number, number][] = [];
    for (let i = 0; i < v.length; i += 2) bands.push([i + 1 < v.length ? v[i + 1] : Infinity, v[i]]);
    this.tickBands = bands;
    this.intervals = info.intervals ?? [];
  }

  /** Tick at `price`: the tick of the first band whose bound is at or above it (1 is written 1.0000 on a US stock), else the current-price tick. */
  tickAt(price: number): number {
    for (const [bound, tick] of this.tickBands) if (Math.abs(price) <= bound) return tick;
    return this.mintick;
  }

  /** "Default" chart precision: `price` rounded to the tick of its band and
   *  shown with that tick's decimals (US stocks: 0.5000 under 1, 123.46
   *  above; NSE: 500.10, 1374.7, 25000), as the reference app's default
   *  price formatter (checked 01/10/2026 on 11 symbols). */
  formatPrice(price: number): string {
    const tick = this.tickAt(price);
    return (Math.round(price / tick) * tick).toFixed(tickDecimals(tick));
  }

  /** Decimals of the tick at `price`: a price move (change, range) is written with the decimals of the price it
   *  moves (a 0.5 change of a 123.45 US stock is 0.50, not the 0.5000 of a price under 1). */
  decimalsAt(price: number): number {
    return tickDecimals(this.tickAt(price));
  }

  /** Schedule of the bottom-bar session choice. */
  spec(session: SessionId): SessionSpec {
    return session === "ETH" ? this.extended : this.regular;
  }

  /** Market state at UNIX-seconds `sec`. */
  status(sec: number): MarketSession {
    if (this.regular.contains(sec)) return "open";
    if (this.premarket?.contains(sec)) return "pre";
    if (this.postmarket?.contains(sec)) return "post";
    return "closed";
  }

  /** Pre- or post-market part a bar starting at `sec` belongs to, or null
   *  (regular session, or outside both). */
  extendedPart(sec: number): "pre" | "post" | null {
    if (this.premarket?.contains(sec)) return "pre";
    if (this.postmarket?.contains(sec)) return "post";
    return null;
  }
}

/** Decimals of a tick (0.05 → 2, 0.25 → 2, 0.1 → 1, 5 → 0). */
function tickDecimals(tick: number): number {
  for (let d = 0; d < 15; d++) {
    const v = tick * 10 ** d;
    if (Math.abs(Math.round(v) - v) < 1e-9 * Math.max(1, v)) return d;
  }
  return 15;
}

const resolved = new Map<string, SymbolSessions>();
const pending = new Map<string, Promise<SymbolSessions>>();
const [version, setVersion] = createSignal(0);

/** Bumped each time a symbol's session resolves (reactive). */
export const sessionsVersion = version;

function keyOf(symbol: string): { key: string; exchange: string; ticker: string } {
  const { exchange, ticker } = splitSymbol(symbol);
  const ex = exchange.toUpperCase();
  const tk = ticker.toUpperCase();
  return { key: `${ex}:${tk}`, exchange: ex, ticker: tk };
}

/** Sessions of `symbol` ("EXCHANGE:TICKER" or a bare ticker). Resolved once,
 *  then served from the cache; concurrent callers share one request. Rejects
 *  when the provider cannot describe the symbol. */
export function symbolSessions(symbol: string): Promise<SymbolSessions> {
  const { key, exchange, ticker } = keyOf(symbol);
  const done = resolved.get(key);
  if (done) return Promise.resolve(done);
  let p = pending.get(key);
  if (!p) {
    // An imported series has its own session (../local-series).
    const info = isLocalSymbol(key)
      ? localSession(key).then((data) => ({ status: "ok" as const, data }))
      : commands.getSymbolSession(`${exchange}:${ticker}`);
    p = info.then((r) => {
      if (r.status === "error") throw new Error(r.error);
      const s = new SymbolSessions(r.data);
      resolved.set(key, s);
      setVersion((v) => v + 1);
      return s;
    });
    p.finally(() => pending.delete(key)).catch(() => undefined);
    pending.set(key, p);
  }
  return p;
}

/** Resolve `symbol`'s sessions again on next use (a re-imported series). */
export function forgetSymbolSessions(symbol: string): void {
  resolved.delete(keyOf(symbol).key);
}

/** Sessions of `symbol` when already resolved, else null (and the resolve is
 *  started). Reactive: a tracking caller re-runs once it resolves. */
export function cachedSymbolSessions(symbol: string): SymbolSessions | null {
  version();
  if (!symbol) return null;
  const done = resolved.get(keyOf(symbol).key);
  if (done) return done;
  void symbolSessions(symbol).catch(() => undefined);
  return null;
}

/** Display time zone of a chart: the symbol's exchange zone when the user
 *  picked "Exchange", else the picked zone. Until the symbol's session
 *  resolves, `fallback` (the last stored zone). Reactive. */
export function displayTimeZone(label: string, fallback: string, symbol: string | undefined): string {
  if (label !== "Exchange" || !symbol) return fallback;
  return cachedSymbolSessions(symbol)?.timeZone ?? fallback;
}
