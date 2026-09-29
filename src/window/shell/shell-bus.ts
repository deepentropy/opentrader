/*
 * Shell bus — window-to-window messages for the tab strip:
 *
 *  - Merge (TV: drag a tab into another window's tab strip, `dragTabIn`): on a
 *    tab drop outside its window, the source asks every other window whether
 *    the screen point is on its tab strip; the window that says yes takes the
 *    tab at the index under the cursor and confirms, and only then the source
 *    drops it. The tab keeps its id, panes and link colour; its charts are
 *    built again in the target webview (TV moves the live page instead).
 *  - Reopen a closed tab in the window it was closed in.
 *
 * Windows share one origin, so a BroadcastChannel reaches them all.
 */
import type { TabChart } from "./tabs";
import { currentWindowLabel } from "./window-bridge";

type Msg =
  | { kind: "strip-query"; id: string; from: string; sx: number; sy: number }
  | { kind: "strip-hit"; id: string; to: string; label: string; index: number }
  | { kind: "merge-tab"; id: string; from: string; to: string; tab: TabChart; index: number }
  | { kind: "merge-ack"; id: string; to: string }
  | { kind: "reopen-tab"; to: string; tab: TabChart; position: number; active: boolean };

const bus: BroadcastChannel | null =
  typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("tv:shell") : null;

let seq = 0;
const newId = () => `${currentWindowLabel()}:${Date.now().toString(36)}:${seq++}`;

/** This window's strip hooks, registered by App. */
export type ShellHandlers = {
  /** Tab index for a drop at this screen point when it is on this window's
   *  tab strip, else null. */
  stripIndexAt: (sx: number, sy: number) => number | null;
  /** Insert a tab (merged in or reopened) and bring this window forward. */
  insertTab: (tab: TabChart, index: number, active: boolean) => void;
};

/** Screen point → this window's client coordinates (CSS px). The window's
 *  outer frame is split evenly left/right and the rest sits on top. */
export function screenToClient(sx: number, sy: number): { x: number; y: number } {
  const side = Math.max(0, (window.outerWidth - window.innerWidth) / 2);
  const top = Math.max(0, window.outerHeight - window.innerHeight - side);
  return { x: sx - window.screenX - side, y: sy - window.screenY - top };
}

export function initShellBus(h: ShellHandlers): () => void {
  if (!bus) return () => {};
  const me = currentWindowLabel();
  const onMsg = (ev: MessageEvent) => {
    const m = ev.data as Msg | null;
    if (!m) return;
    if (m.kind === "strip-query" && m.from !== me) {
      if (document.visibilityState === "hidden") return;
      const index = h.stripIndexAt(m.sx, m.sy);
      if (index !== null) bus.postMessage({ kind: "strip-hit", id: m.id, to: m.from, label: me, index } satisfies Msg);
    } else if (m.kind === "merge-tab" && m.to === me) {
      h.insertTab(m.tab, m.index, true);
      bus.postMessage({ kind: "merge-ack", id: m.id, to: m.from } satisfies Msg);
    } else if (m.kind === "reopen-tab" && m.to === me) {
      h.insertTab(m.tab, m.position, m.active);
    }
  };
  bus.addEventListener("message", onMsg);
  return () => bus.removeEventListener("message", onMsg);
}

/** Wait for the first message matching `pick`, or null after `ms`. */
function waitFor<T>(pick: (m: Msg) => T | null, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    if (!bus) return resolve(null);
    const done = (v: T | null) => {
      bus.removeEventListener("message", onMsg);
      clearTimeout(timer);
      resolve(v);
    };
    const onMsg = (ev: MessageEvent) => {
      const v = pick(ev.data as Msg);
      if (v !== null) done(v);
    };
    const timer = setTimeout(() => done(null), ms);
    bus.addEventListener("message", onMsg);
  });
}

/** The other window whose tab strip is under this screen point, if any. */
export async function findStripAt(sx: number, sy: number): Promise<{ label: string; index: number } | null> {
  if (!bus) return null;
  const me = currentWindowLabel();
  const id = newId();
  const reply = waitFor((m) => (m.kind === "strip-hit" && m.id === id && m.to === me ? { label: m.label, index: m.index } : null), 150);
  bus.postMessage({ kind: "strip-query", id, from: me, sx, sy } satisfies Msg);
  return reply;
}

/** Hand a tab to another window; true once that window confirms it took it. */
export async function sendTabTo(label: string, tab: TabChart, index: number): Promise<boolean> {
  if (!bus) return false;
  const me = currentWindowLabel();
  const id = newId();
  const ack = waitFor((m) => (m.kind === "merge-ack" && m.id === id && m.to === me ? true : null), 1000);
  bus.postMessage({ kind: "merge-tab", id, from: me, to: label, tab, index } satisfies Msg);
  return (await ack) === true;
}

/** Reopen a closed tab in another (open) window. */
export function reopenTabIn(label: string, tab: TabChart, position: number, active: boolean): void {
  bus?.postMessage({ kind: "reopen-tab", to: label, tab, position, active } satisfies Msg);
}
