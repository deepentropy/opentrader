/*
 * Web build: the link to the OpenTrader server (src-tauri/crates/server) that
 * stands in for the desktop backend. Commands go out as HTTP calls, live events
 * come back over one WebSocket per tab.
 *
 * The tab is a client of the server under a random id (kept for the tab's
 * life, reloads included). Its live subscriptions belong to its WebSocket: the
 * server drops them when it closes, so they are sent again after a reconnect.
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

let socket: WebSocket | null = null;
let ready: Promise<void> | null = null;
let retryMs = RETRY_START_MS;

function eventsUrl(): string {
  const origin = BASE || location.origin;
  return `${origin.replace(/^http/, "ws")}/api/events?client=${encodeURIComponent(CLIENT)}`;
}

/** Resolves once the WebSocket is open (opening it on first use). */
function connected(): Promise<void> {
  if (ready) return ready;
  ready = new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(eventsUrl());
    socket = ws;
    let opened = false;
    ws.onopen = () => {
      opened = true;
      retryMs = RETRY_START_MS;
      resolve();
    };
    ws.onmessage = (m) => {
      let msg: { event?: string; payload?: unknown };
      try {
        msg = JSON.parse(String(m.data));
      } catch {
        return;
      }
      if (!msg.event) return;
      for (const fn of handlers.get(msg.event) ?? []) {
        try {
          fn(msg.payload);
        } catch (e) {
          console.error(`[server] ${msg.event} handler failed`, e);
        }
      }
    };
    ws.onclose = () => {
      if (socket !== ws) return;
      socket = null;
      ready = null;
      if (!opened) reject("server unreachable");
      // Reconnect, then subscribe again: the server dropped this tab's subscriptions.
      const wait = retryMs;
      retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
      setTimeout(() => void connected().then(resubscribe, () => undefined), wait);
    };
  });
  return ready;
}

function resubscribe(): void {
  for (const { cmd, args } of sticky.values()) {
    if (cmd === "screener_close") continue;
    void post(cmd, args).catch((e) => console.warn(`[server] ${cmd} after reconnect failed`, e));
  }
}
