/**
 * A BroadcastChannel to the app's other windows, or null when there is none.
 * A browser that denies storage to the page (a third-party embed with
 * cross-site cookies blocked) throws a SecurityError on creating one: the app
 * then runs on its own instead of failing to load (#364).
 */
export function openChannel(name: string): BroadcastChannel | null {
  if (typeof BroadcastChannel === "undefined") return null;
  try {
    return new BroadcastChannel(name);
  } catch {
    return null;
  }
}
