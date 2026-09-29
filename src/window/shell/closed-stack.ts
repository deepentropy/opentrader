/*
 * Closed tabs and windows — TV Desktop's undo stack behind "Reopen closed tab"
 * / "Reopen closed window" (main menu + Ctrl+Shift+T):
 *
 *  - one stack for the whole app (every window), newest on top, 30 entries,
 *    kept across restarts;
 *  - a closed tab comes back in the window it was closed in, at its position,
 *    active if it was active, with its link colour; if that window is gone,
 *    the entry is used up and nothing opens (TV `tab-closed` undo handler);
 *  - a window closed while other windows stay open comes back with its tabs
 *    and bounds (TV `window-closed`); a window closed because its last tab
 *    moved to another window is not recorded.
 *
 * Stored in localStorage (shared by all windows, written synchronously, so a
 * closing window's entry is never lost); other windows follow through the
 * `storage` event.
 */
import { createSignal } from "solid-js";
import type { TabChart } from "./tabs";
import type { WindowState } from "../../bindings";

export type ClosedTab = {
  kind: "tab";
  /** Label of the window the tab was closed in. */
  win: string;
  position: number;
  active: boolean;
  tab: TabChart;
};

export type ClosedWindow = {
  kind: "window";
  win: string;
  tabs: TabChart[];
  activeId: string;
  /** Normal bounds from the Rust window session (absent: default size). */
  bounds?: WindowState;
};

export type ClosedEntry = ClosedTab | ClosedWindow;

const KEY = "tv:closed-stack";
const MAX = 30;

function load(): ClosedEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const [stack, setStack] = createSignal<ClosedEntry[]>(load());

if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === KEY) setStack(load());
  });
}

function save(next: ClosedEntry[]): void {
  setStack(next);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch (e) {
    console.error("[closed-stack] save failed", e);
  }
}

export function pushClosed(entry: ClosedEntry): void {
  const next = [...load(), entry];
  save(next.slice(Math.max(0, next.length - MAX)));
}

/** Take the newest entry (read fresh: another window may have changed it). */
export function popClosed(): ClosedEntry | undefined {
  const cur = load();
  const top = cur.pop();
  save(cur);
  return top;
}

/** Main-menu label of the newest entry, or null when there is none. */
export function reopenLabel(): string | null {
  const s = stack();
  const top = s[s.length - 1];
  if (!top) return null;
  return top.kind === "tab" ? "Reopen closed tab" : "Reopen closed window";
}
