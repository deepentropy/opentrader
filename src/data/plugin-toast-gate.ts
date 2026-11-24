/*
 * Keeps a plugin from flooding the screen with its toasts (`plugin.toast`, plugins/PROTOCOL.md). A message the plugin
 * sends again within a few seconds counts on the toast already shown ("×3") instead of adding one, and each plugin
 * shows a few new toasts a minute of each level at most (so routine messages never hide an error); the rest are only
 * in its log, which the app writes before this.
 */

/** How long a toast takes the same message again, in ms. */
export const REPEAT_MS = 10_000;
/** New toasts of one level a plugin may show in a minute. */
export const PER_MINUTE = 5;

export type ToastDecision = "show" | "repeat" | "drop";

/** The key a repeat is found by: the plugin, the level and the text. */
export const toastKey = (plugin: string, level: string, message: string) => `${plugin}\n${level}\n${message}`;

export function createPluginToastGate() {
  /** Last time each key was shown or repeated. */
  const seen = new Map<string, number>();
  /** Times of each plugin's new toasts of each level in the last minute. */
  const shown = new Map<string, number[]>();
  return (plugin: string, level: string, message: string, now: number): ToastDecision => {
    const key = toastKey(plugin, level, message);
    for (const [k, at] of seen) if (now - at >= REPEAT_MS) seen.delete(k);
    if (seen.has(key)) {
      seen.set(key, now);
      return "repeat";
    }
    const rate = `${plugin}\n${level}`;
    const recent = (shown.get(rate) ?? []).filter((at) => now - at < 60_000);
    if (recent.length >= PER_MINUTE) {
      shown.set(rate, recent);
      return "drop";
    }
    recent.push(now);
    shown.set(rate, recent);
    seen.set(key, now);
    return "show";
  };
}
