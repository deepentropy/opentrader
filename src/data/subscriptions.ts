/*
 * Live-tick subscription coordinator.
 *
 * The backend exposes a single "watchlist" subscription slot that polls/streams
 * a set of symbols and emits a `trade-tick` for each. More than one feature now
 * needs symbols on that feed: the watchlist rows themselves and the alert engine
 * (which must receive ticks for alert symbols even when they aren't on screen).
 *
 * Each contributor declares its desired symbol set under a stable key; this
 * module sends the de-duplicated union to the backend whenever any contributor
 * changes. Because the backend replaces its whole set on each call, the union
 * approach avoids the overlapping subscribe/unsubscribe bugs a per-contributor
 * channel would have.
 *
 * The web server streams at most WEB_LIVE_SYMBOLS symbols to one page and
 * refuses a longer set whole, which left a long watchlist with no live prices
 * at all (#358). On the web the union is cut to that many instead, the
 * symbols that matter most kept first (liveSymbols).
 */
import { setWatchlistSubscription } from "./datafeed";

/** Symbols the web server streams to one page (MAX_WATCHLIST in crates/server/src/invoke.rs). */
export const WEB_LIVE_SYMBOLS = 500;

/** Contributors whose symbols are kept last when the set is cut, in this
 *  order: the watchlist rows on screen, then the rest of the open list in its
 *  order, then the lists with a list alert. The others (alerts, details, tab
 *  titles, widgets: a few symbols each) come first. */
const LATE = ["watchlist-shown", "watchlist", "list-alerts"];

/** The symbols to stream: every contributor's, once each (upper-cased), at
 *  most `max`, the first ones kept in the order above. */
export function liveSymbols(sets: ReadonlyMap<string, readonly string[]>, max: number): string[] {
  const rank = (key: string) => LATE.indexOf(key);
  const ordered = [...sets.entries()].sort((a, b) => rank(a[0]) - rank(b[0]));
  const out = new Set<string>();
  for (const [, symbols] of ordered) {
    for (const s of symbols) {
      if (out.size >= max) return [...out].sort();
      out.add(s.toUpperCase());
    }
  }
  return [...out].sort();
}

const isDesktop = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const contributors = new Map<string, string[]>();
// null (not "") so the first legitimately-empty union is still sent once — an
// empty string would collide with the "no symbols" union and be skipped.
let lastSent: string | null = null;

/** On the web, one call a second at most: a list whose names are being
 *  resolved changes many times a second, and the server counts each call
 *  against the visitor's rate. The last change always goes out. */
const WEB_GAP_MS = 1000;
/** A refused call (server busy, rate limit) is tried again after this. */
const RETRY_MS = 5000;
let sentAt = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

function flush(): void {
  const wait = isDesktop() ? 0 : sentAt + WEB_GAP_MS - Date.now();
  if (wait > 0) {
    timer ??= setTimeout(() => {
      timer = undefined;
      flush();
    }, wait);
    return;
  }
  const union = liveSymbols(contributors, isDesktop() ? Infinity : WEB_LIVE_SYMBOLS);
  const key = union.join(",");
  if (key === lastSent) return; // nothing changed — skip the round-trip
  lastSent = key;
  sentAt = Date.now();
  setWatchlistSubscription(union).catch((e) => {
    console.warn("[subscriptions] setWatchlistSubscription failed:", e);
    // Not taken: the same set goes again (unless another replaced it).
    if (lastSent !== key) return;
    lastSent = null;
    timer ??= setTimeout(() => {
      timer = undefined;
      flush();
    }, RETRY_MS);
  });
}

/** Declare (or replace) a contributor's desired symbol set. */
export function setSubscription(key: string, symbols: string[]): void {
  contributors.set(key, symbols);
  flush();
}

/** Drop a contributor entirely (e.g. on unmount). */
export function clearSubscription(key: string): void {
  if (contributors.delete(key)) flush();
}
