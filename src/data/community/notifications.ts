/*
 * Community notifications (#208): the unread count, asked every minute while
 * signed in (the dot on the Community rail button, the panel menu), the list,
 * and the new ones as they arrive (the notifier's pop-ups). A pop-up or a
 * list line opens its post in the panel through `requestOpenPost`.
 */
import { createSignal } from "solid-js";
import { api, type Notice } from "./api";
import { me } from "./session";

const POLL_MS = 60_000;

const [unread, setUnread] = createSignal(0);
const [incoming, setIncoming] = createSignal<Notice[]>([]);
const [openPost, setOpenPost] = createSignal<{ id: string; at: number; openChart?: boolean } | null>(null);
/** Unread notifications; new ones since the last look (pop-ups); a post to open in the panel. */
export { unread, incoming, openPost };

let timer: ReturnType<typeof setInterval> | null = null;
/** Newest notification already seen (no pop-up for it again). */
let newestSeen = 0;
let primed = false;

async function poll(): Promise<void> {
  if (!me()) {
    setUnread(0);
    return;
  }
  try {
    const { unread: n } = await api.unread();
    const grew = n > unread();
    setUnread(n);
    if (!grew && primed) return;
    const { notifications } = await api.notifications();
    const fresh = notifications.filter((x) => !x.read_at && x.created_at > newestSeen);
    newestSeen = Math.max(newestSeen, ...notifications.map((x) => x.created_at), 0);
    // The ones waiting at start are counted, not popped up.
    if (primed && fresh.length) setIncoming((l) => [...l, ...fresh].slice(-5));
    primed = true;
  } catch {
    // Offline or signed out: the next round tries again.
  }
}

/** Starts asking (once; harmless to call again). */
export function startNotifications(): void {
  if (timer) return;
  void poll();
  timer = setInterval(() => void poll(), POLL_MS);
}

export function refreshNotifications(): Promise<void> {
  return poll();
}

export function dismissIncoming(id: string): void {
  setIncoming((l) => l.filter((x) => x.id !== id));
}

export async function markAllRead(): Promise<void> {
  if (!unread()) return;
  setUnread(0);
  setIncoming([]);
  await api.markRead().catch(() => {});
}

/** Opens a post in the Community panel (from a pop-up, a link…); `openChart`: its shared chart on the active chart too. */
export function requestOpenPost(id: string, opts: { openChart?: boolean } = {}): void {
  setOpenPost({ id, at: Date.now(), openChart: opts.openChart });
}
