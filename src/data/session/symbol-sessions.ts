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

/** Bottom-bar session choice: regular hours or the extended (whole traded)
 *  day. */
export type SessionId = "RTH" | "ETH";

/** Market state at a time: in the regular session, pre- or post-market, or
 *  closed. */
export type MarketSession = "open" | "pre" | "post" | "closed";

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
  /** Regular session spec string ("0930-1600"), for script `syminfo.session`. */
  readonly regularSpec: string;
  /** Extended session spec string (the regular one when there is none). */
  readonly extendedSpec: string;

  constructor(info: SymbolSession) {
    const tz = info.timezone;
    const sub = (id: string) => info.subsessions.find((s) => s.id === id);
    const spec = (session: string, corrections: string) => new SessionSpec(tz, session, info.holidays, corrections);
    const ext = sub("extended");
    const pre = sub("premarket");
    const post = sub("postmarket");
    this.timeZone = tz;
    this.regularSpec = info.session;
    this.extendedSpec = ext?.session ?? info.session;
    this.regular = spec(info.session, info.corrections);
    this.extended = ext ? spec(ext.session, ext.corrections) : this.regular;
    this.premarket = pre ? spec(pre.session, pre.corrections) : null;
    this.postmarket = post ? spec(post.session, post.corrections) : null;
    this.hasExtendedHours = ext !== undefined && ext.session !== info.session;
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
    p = commands.getSymbolSession(exchange, ticker).then((r) => {
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
