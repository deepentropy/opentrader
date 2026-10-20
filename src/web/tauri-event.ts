/*
 * Web build stand-in for `@tauri-apps/api/event` (aliased in vite.config.ts):
 * `listen` receives the server's events (see server.ts); `emit` reaches the
 * listeners of this tab. The rest of the module is the original.
 */
import { onServerEvent } from "./server";
import type { EventCallback, EventName, UnlistenFn } from "../../node_modules/@tauri-apps/api/event.js";

// By path: the package name is aliased to this file.
export * from "../../node_modules/@tauri-apps/api/event.js";

let nextId = 1;
const local = new Map<string, Set<(payload: unknown) => void>>();

export async function listen<T>(event: EventName, handler: EventCallback<T>): Promise<UnlistenFn> {
  const fn = (payload: unknown) => handler({ event, id: nextId++, payload: payload as T });
  const offServer = onServerEvent(event, fn);
  let set = local.get(event);
  if (!set) local.set(event, (set = new Set()));
  set.add(fn);
  return () => {
    offServer();
    set.delete(fn);
  };
}

export async function once<T>(event: EventName, handler: EventCallback<T>): Promise<UnlistenFn> {
  let off: UnlistenFn = () => {};
  off = await listen<T>(event, (e) => {
    off();
    handler(e);
  });
  return off;
}

export async function emit<T>(event: EventName, payload?: T): Promise<void> {
  for (const fn of [...(local.get(event) ?? [])]) fn(payload);
}
