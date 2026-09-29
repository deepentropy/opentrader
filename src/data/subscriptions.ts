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
 */
import { setWatchlistSubscription } from "./datafeed";

const contributors = new Map<string, string[]>();
// null (not "") so the first legitimately-empty union is still sent once — an
// empty string would collide with the "no symbols" union and be skipped.
let lastSent: string | null = null;

function flush(): void {
  const union = [...new Set([...contributors.values()].flat().map((s) => s.toUpperCase()))].sort();
  const key = union.join(",");
  if (key === lastSent) return; // nothing changed — skip the round-trip
  lastSent = key;
  setWatchlistSubscription(union).catch((e) =>
    console.warn("[subscriptions] setWatchlistSubscription failed:", e),
  );
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
