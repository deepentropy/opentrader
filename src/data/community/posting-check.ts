/*
 * The bot check before a new account's first post or comment (#219). The
 * server refuses with `check: true`; `withPostingCheck` then shows the prompt
 * (PostingCheckPrompt), the user passes the check in the browser, and the
 * post is sent again by itself once the account is checked.
 */
import { createSignal } from "solid-js";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, CommunityError } from "./api";
import { refreshMe } from "./session";

type Pending = { resolve: () => void; reject: (e: Error) => void };

const [pending, setPending] = createSignal<Pending | null>(null);
const [waiting, setWaiting] = createSignal(false);
const [checkError, setCheckError] = createSignal<string | null>(null);
/** The prompt is shown; the check page is open and the account is being watched; what went wrong. */
export { pending, waiting, checkError };

/** Runs `send`; when the bot check is needed first, after it. */
export async function withPostingCheck<T>(send: () => Promise<T>): Promise<T> {
  try {
    return await send();
  } catch (e) {
    if (!(e instanceof CommunityError && e.data.check)) throw e;
    await new Promise<void>((resolve, reject) => {
      setCheckError(null);
      setPending({ resolve, reject });
    });
    return send();
  }
}

const WATCH_MS = 2_000;
const WATCH_FOR_MS = 10 * 60_000;
let watching: ReturnType<typeof setInterval> | null = null;

function stopWatching(): void {
  if (watching) clearInterval(watching);
  watching = null;
  setWaiting(false);
}

/** "Open the check": the page in the browser, then the account is watched until it is checked. */
export async function openCheck(): Promise<void> {
  setCheckError(null);
  try {
    const { url } = await api.checkStart();
    await openUrl(url);
  } catch (e) {
    setCheckError(e instanceof Error ? e.message : String(e));
    return;
  }
  stopWatching();
  setWaiting(true);
  const until = Date.now() + WATCH_FOR_MS;
  watching = setInterval(async () => {
    if (Date.now() > until) {
      stopWatching();
      setCheckError("The check took too long. Open it again.");
      return;
    }
    const m = await api.me().catch(() => null);
    if (!m?.user.post_checked) return;
    stopWatching();
    await refreshMe().catch(() => {});
    const p = pending();
    setPending(null);
    p?.resolve();
  }, WATCH_MS);
}

export function cancelCheck(): void {
  stopWatching();
  const p = pending();
  setPending(null);
  p?.reject(new CommunityError(0, "Not sent: confirm that you're not a robot first."));
}
