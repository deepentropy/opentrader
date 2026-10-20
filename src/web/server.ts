/*
 * Web build: the link to the OpenTrader server (src-tauri/crates/server) that
 * stands in for the desktop backend. Commands go out as HTTP calls, live events
 * come back over one WebSocket per tab.
 *
 * The tab is a client of the server under a random id (kept for the tab's
 * life, reloads included). Its live subscriptions belong to its WebSocket: the
 * server drops them when it closes, so they are sent again after a reconnect.
 * Where the WebSocket cannot open (an extension, a proxy or an antivirus
 * blocking it), the tab reads the same events by polling `/api/poll`.
 */

/** Server origin; empty = the page's own (the dev server proxies /api). */
const BASE = ((import.meta.env.VITE_SERVER_URL as string | undefined) ?? "").replace(/\/$/, "");

const CLIENT_KEY = "ot:web-client";

function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function clientId(): string {
  try {
    const kept = sessionStorage.getItem(CLIENT_KEY);
    if (kept) return kept;
    const id = newId();
    sessionStorage.setItem(CLIENT_KEY, id);
    return id;
  } catch {
    return newId();
  }
}

export const CLIENT = clientId();

// ── Commands ──

/** Subscription commands: they need the WebSocket, and are replayed after a
 *  reconnect (keyed so the latest call per slot wins). */
const STICKY: Record<string, (args: Record<string, unknown>) => string | null> = {
  set_chart_subscription: (a) => `chart:${String(a.pane)}`,
  set_watchlist_subscription: () => "watchlist",
  screener_open: (a) => `screener:${String(a.owner)}`,
  screener_close: (a) => `screener:${String(a.owner)}`,
};
const sticky = new Map<string, { cmd: string; args: Record<string, unknown> }>();

async function post(cmd: string, args: Record<string, unknown>): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/api/invoke/${cmd}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-opentrader-client": CLIENT },
      body: JSON.stringify(args),
    });
  } catch (e) {
    // As the desktop bridge: a failed call rejects with the error string.
    throw `server unreachable: ${e instanceof Error ? e.message : String(e)}`;
  }
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) throw typeof body === "string" ? body : `${cmd} failed (${res.status})`;
  return body;
}

/** Run a server command. Its error string rejects the promise. */
export async function call(cmd: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const key = STICKY[cmd]?.(args);
  if (key == null) return post(cmd, args);
  sticky.set(key, { cmd, args });
  await connected();
  return post(cmd, args);
}

// ── Events ──

type Handler = (payload: unknown) => void;
const handlers = new Map<string, Set<Handler>>();

/** Receive the server events named `name`. Returns the unsubscribe. */
export function onServerEvent(name: string, fn: Handler): () => void {
  let set = handlers.get(name);
  if (!set) handlers.set(name, (set = new Set()));
  set.add(fn);
  void connected().catch(() => undefined);
  return () => {
    set.delete(fn);
  };
}

const RETRY_START_MS = 1000;
const RETRY_MAX_MS = 30_000;
/** A WebSocket not open after this long counts as failed. */
const OPEN_TIMEOUT_MS = 8000;
/** WebSockets that never opened, in a row, before switching to polling. */
const FAILS_BEFORE_POLLING = 2;

let socket: WebSocket | null = null;
let ready: Promise<void> | null = null;
let retryMs = RETRY_START_MS;
let failedOpens = 0;
/** The tab reads its events by polling (its WebSockets cannot open). */
let polling = false;

function eventsUrl(): string {
  const origin = BASE || location.origin;
  return `${origin.replace(/^http/, "ws")}/api/events?client=${encodeURIComponent(CLIENT)}`;
}

function dispatch(msg: { event?: string; payload?: unknown }): void {
  if (!msg.event) return;
  for (const fn of handlers.get(msg.event) ?? []) {
    try {
      fn(msg.payload);
    } catch (e) {
      console.error(`[server] ${msg.event} handler failed`, e);
    }
  }
}

/** Resolves once the tab is connected: its WebSocket open, or its poll
 *  session started (opening them on first use). */
function connected(): Promise<void> {
  if (ready) return ready;
  ready = polling ? startPolling() : openSocket();
  return ready;
}

function openSocket(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(eventsUrl());
    socket = ws;
    let opened = false;
    const timer = setTimeout(() => {
      if (!opened) ws.close();
    }, OPEN_TIMEOUT_MS);
    ws.onopen = () => {
      opened = true;
      clearTimeout(timer);
      retryMs = RETRY_START_MS;
      failedOpens = 0;
      resolve();
    };
    ws.onmessage = (m) => {
      try {
        dispatch(JSON.parse(String(m.data)));
      } catch {
        /* not an event */
      }
    };
    ws.onclose = () => {
      clearTimeout(timer);
      if (socket !== ws) return;
      socket = null;
      ready = null;
      if (!opened) {
        reject("server unreachable");
        // Blocked on this browser (an extension, a proxy): the same events by polling.
        if (++failedOpens >= FAILS_BEFORE_POLLING) {
          polling = true;
          console.warn("[server] live connection blocked; reading updates by polling");
          void connected().then(resubscribe, () => undefined);
          return;
        }
      }
      // Reconnect, then subscribe again: the server dropped this tab's subscriptions.
      const wait = retryMs;
      retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
      setTimeout(() => void connected().then(resubscribe, () => undefined), wait);
    };
  });
}

/** One poll: the events queued for the tab. `wait` false answers at once. */
async function pollOnce(wait: boolean): Promise<{ events: { event?: string; payload?: unknown }[]; fresh: boolean }> {
  const res = await fetch(`${BASE}/api/poll?client=${encodeURIComponent(CLIENT)}${wait ? "" : "&wait=0"}`, { cache: "no-store" });
  if (!res.ok) throw `poll failed (${res.status})`;
  return { events: await res.json(), fresh: res.headers.get("x-opentrader-session") === "new" };
}

/** Start the poll session (resolves once the server has it), then keep polling. */
function startPolling(): Promise<void> {
  return pollOnce(false).then(
    ({ events }) => {
      events.forEach(dispatch);
      void pollLoop();
    },
    (e) => {
      ready = null;
      const wait = retryMs;
      retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
      setTimeout(() => void connected().then(resubscribe, () => undefined), wait);
      throw e;
    },
  );
}

/** Shortest time between two polls. */
const POLL_GAP_MS = 1000;

async function pollLoop(): Promise<void> {
  for (;;) {
    const started = Date.now();
    try {
      const { events, fresh } = await pollOnce(true);
      retryMs = RETRY_START_MS;
      // A new session: the server forgot this tab's subscriptions.
      if (fresh) resubscribe();
      events.forEach(dispatch);
      const rest = POLL_GAP_MS - (Date.now() - started);
      if (rest > 0) await new Promise((r) => setTimeout(r, rest));
    } catch {
      await new Promise((r) => setTimeout(r, retryMs));
      retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
    }
  }
}

function resubscribe(): void {
  for (const { cmd, args } of sticky.values()) {
    if (cmd === "screener_close") continue;
    void post(cmd, args).catch((e) => console.warn(`[server] ${cmd} after reconnect failed`, e));
  }
}
