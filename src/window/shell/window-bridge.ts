/*
 * Window bridge — the thin Tauri-multi-window seam behind tab detach. Replaces
 * the reference mock's Electron IPC (which spawned a BrowserWindow with the
 * torn-off tab) with Tauri 2's WebviewWindow API.
 *
 * Everything here is guarded by isTauri() and degrades to a no-op in a plain
 * browser (e.g. `vite dev` without the Tauri shell), so the rest of the app —
 * and the headless verify harness — keeps working. Importing the Tauri module
 * is safe in a browser (it only touches __TAURI_INTERNALS__ when a function is
 * actually called); the guards stop those calls from running off-shell.
 *
 * State handoff: Tauri's WebView2 windows share the same localStorage origin,
 * so per-window tab state must be label-scoped (see tabs.ts). A detach writes
 * the torn-off tab under `tv:detach:<newLabel>`; the new window reads + clears
 * it on mount (takeDetachPayload) and seeds its single tab from it.
 */
import { getAllWebviewWindows, getCurrentWebviewWindow, WebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { TabChart } from "./tabs";
import { clearTabs, tabTitle } from "./tabs";
import { pushClosed, type ClosedWindow } from "./closed-stack";

const DETACH_PREFIX = "tv:detach:";

/** True inside the Tauri shell (where the window APIs are wired up). */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** This webview's window label ("main" for the primary window, "chart-…" for
 *  detached ones). Falls back to "main" outside Tauri so storage still scopes. */
export function currentWindowLabel(): string {
  if (!isTauri()) return "main";
  try {
    return getCurrentWebviewWindow().label;
  } catch {
    return "main";
  }
}

/** Pop the handoff tab a detach left for `label` (clearing it), or null. */
export function takeDetachPayload(label: string): TabChart | null {
  try {
    const raw = localStorage.getItem(DETACH_PREFIX + label);
    if (!raw) return null;
    localStorage.removeItem(DETACH_PREFIX + label);
    return JSON.parse(raw) as TabChart;
  } catch {
    return null;
  }
}

let detachSeq = 0;

/**
 * Detach `tab` into a brand-new window positioned near the drop point. Writes
 * the handoff payload, then opens a WebviewWindow loading the same frontend.
 * Returns true if a window was actually created (i.e. inside Tauri).
 *
 * `screenX/screenY` are the global cursor coords at drop; the window is offset
 * up-left a little so the tab strip lands under the cursor.
 */
export function detachTabToWindow(tab: TabChart, screenX: number, screenY: number): boolean {
  if (!isTauri()) return false;
  try {
    const label = `chart-${Date.now().toString(36)}-${detachSeq++}`;
    localStorage.setItem(DETACH_PREFIX + label, JSON.stringify(tab));
    const win = new WebviewWindow(label, {
      url: "index.html",
      x: Math.max(0, Math.round(screenX - 120)),
      y: Math.max(0, Math.round(screenY - 18)),
      width: 1280,
      height: 800,
      title: tabTitle(tab),
      focus: true,
      // Frameless like the main window — the app draws its own title bar
      // (tab strip + WindowControls), so the native chrome must be off here
      // too or detached windows would show a duplicate OS bar.
      decorations: false,
      shadow: true,
      // Off so the webview's native file-drop handler doesn't swallow in-page
      // HTML5 drag-and-drop (watchlist reorder, object-tree reorder). Mirrors
      // the main window's tauri.conf.json setting.
      dragDropEnabled: false,
    });
    // If creation fails, drop the orphaned handoff so it can't leak into a
    // later window that happens to reuse the label.
    win.once("tauri://error", () => {
      try { localStorage.removeItem(DETACH_PREFIX + label); } catch { /* noop */ }
    });
    return true;
  } catch {
    return false;
  }
}

let newWindowSeq = 0;

/**
 * Open a fresh app window ("New window", Ctrl+N). Unlike detach, it writes
 * no handoff payload — the new window's label-scoped storage is empty, so it
 * boots with a single default tab (see loadTabs). Frameless like the main
 * window; cascaded a little so stacked windows don't perfectly overlap.
 * Returns true if a window was created (i.e. inside Tauri).
 */
export function openNewWindow(): boolean {
  if (!isTauri()) return false;
  try {
    const label = `chart-${Date.now().toString(36)}-${detachSeq++}`;
    const off = (newWindowSeq++ % 6) * 32;
    const win = new WebviewWindow(label, {
      url: "index.html",
      x: 120 + off,
      y: 120 + off,
      width: 1280,
      height: 800,
      title: "OpenTrader",
      focus: true,
      decorations: false,
      shadow: true,
      // See detachTabToWindow — keep in-page HTML5 DnD working.
      dragDropEnabled: false,
    });
    win.once("tauri://error", () => {
      /* nothing persisted to clean up — fresh windows seed themselves */
    });
    return true;
  } catch {
    return false;
  }
}

/** Remove every persisted key for a window label (tab state + any stray handoff). */
function clearWindowStorage(label: string): void {
  clearTabs(label);
  try {
    localStorage.removeItem(DETACH_PREFIX + label);
  } catch {
    /* noop */
  }
}

/**
 * Wire localStorage cleanup for this window and return a disposer:
 *  - a window the user closes while other windows stay open clears its own
 *    label-scoped state (the Rust window session forgets it too);
 *    the last window, whose close quits the app, keeps its tabs for the
 *    restart (src-tauri/src/window_session.rs recreates it);
 *  - the main window, on launch, sweeps any `chart-*` state whose window is no
 *    longer open — catching windows lost to a crash or force-kill, where the
 *    close handler never ran. The session restores its windows before main's
 *    page runs, so their state is kept.
 * No-op (returns a no-op disposer) outside the Tauri shell.
 */
export async function initWindowStorageCleanup(label: string): Promise<() => void> {
  if (!isTauri()) return () => {};
  let unlisten: () => void = () => {};
  try {
    unlisten = await getCurrentWebviewWindow().onCloseRequested(async () => {
      if ((await getAllWebviewWindows()).length <= 1) return;
      // A window the user closes goes on the undo stack ("Reopen closed
      // window"); one that closes because its last tab moved out does not.
      if (!closingAfterMove) await recordClosedWindow(label);
      clearWindowStorage(label);
    });
  } catch {
    /* best-effort */
  }
  if (label !== "main") return unlisten;
  // Main window: GC orphans from prior sessions. Safe on reload too — currently
  // open windows are excluded, so live detached windows keep their state.
  try {
    const open = new Set((await getAllWebviewWindows()).map((w) => w.label));
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      const m = key?.match(/^tv:(?:tabs|active-tab|detach):(chart-.+)$/);
      if (m && !open.has(m[1])) localStorage.removeItem(key!);
    }
  } catch {
    /* best-effort */
  }
  return unlisten;
}

/** Set when this window closes because its last tab moved to another window. */
let closingAfterMove = false;
export function markClosingAfterMove(): void {
  closingAfterMove = true;
}

/** Push this closing window (tabs + normal bounds) on the closed stack. */
async function recordClosedWindow(label: string): Promise<void> {
  try {
    const tabs = JSON.parse(localStorage.getItem(`tv:tabs:${label}`) ?? "[]") as TabChart[];
    if (!Array.isArray(tabs) || tabs.length === 0) return;
    const activeId = localStorage.getItem(`tv:active-tab:${label}`) ?? tabs[0].id;
    const { commands } = await import("../../bindings");
    const bounds = (await commands.takeClosedWindowBounds(label)) ?? undefined;
    pushClosed({ kind: "window", win: label, tabs, activeId, bounds });
  } catch (e) {
    console.error("[window-bridge] could not record the closed window", e);
  }
}

/**
 * Reopen a closed window ("Reopen closed window"): its tabs go under its
 * label (a fresh label if that one is open again), then the Rust window
 * session opens it at its saved bounds, or a default window is opened.
 */
export async function reopenClosedWindow(entry: ClosedWindow): Promise<void> {
  if (!isTauri()) return;
  const open = new Set((await getAllWebviewWindows()).map((w) => w.label));
  const label = open.has(entry.win) ? `chart-${Date.now().toString(36)}-${detachSeq++}` : entry.win;
  localStorage.setItem(`tv:tabs:${label}`, JSON.stringify(entry.tabs));
  localStorage.setItem(`tv:active-tab:${label}`, entry.activeId);
  if (entry.bounds) {
    const { commands } = await import("../../bindings");
    const res = await commands.openWindow({ ...entry.bounds, label });
    if (res.status === "ok") return;
    console.error("[window-bridge] reopen at saved bounds failed", res.error);
  }
  const win = new WebviewWindow(label, {
    url: "index.html",
    width: 1280,
    height: 800,
    title: "OpenTrader",
    focus: true,
    decorations: false,
    shadow: true,
    dragDropEnabled: false,
  });
  win.once("tauri://error", () => clearWindowStorage(label));
}

/**
 * Main window, before the tabs load: when the Rust window session made main
 * stand for another saved window (main had been closed while that one stayed
 * open), move that window's tabs into main's keys. No-op otherwise.
 */
export async function adoptSavedWindowTabs(): Promise<void> {
  if (!isTauri() || currentWindowLabel() !== "main") return;
  try {
    const { commands } = await import("../../bindings");
    const from = await commands.takeAdoptedWindow();
    if (!from) return;
    for (const key of ["tv:tabs:", "tv:active-tab:"]) {
      const v = localStorage.getItem(key + from);
      if (v !== null) localStorage.setItem(key + "main", v);
      localStorage.removeItem(key + from);
    }
  } catch {
    /* best-effort: main keeps its own tabs */
  }
}

/**
 * Toggle this window's fullscreen state (Shift+F / header fullscreen
 * button). Inside the Tauri shell this flips the native webview-window flag;
 * in a plain browser (vite dev / verify harness) it falls back to the DOM
 * Fullscreen API so the shortcut still does something. Best-effort either way.
 */
export async function toggleFullscreen(): Promise<void> {
  if (isTauri()) {
    try {
      const win = getCurrentWebviewWindow();
      await win.setFullscreen(!(await win.isFullscreen()));
    } catch {
      /* noop */
    }
    return;
  }
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch {
    /* noop — not all browser contexts allow programmatic fullscreen */
  }
}

/** Close this window (used when the last tab of a detached window is closed). */
export function closeCurrentWindow(): void {
  if (!isTauri()) return;
  try {
    void getCurrentWebviewWindow().close();
  } catch {
    /* noop */
  }
}
