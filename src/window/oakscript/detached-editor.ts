/*
 * The OakScript editor out of its chart (#325, More menu "Open editor"), as the reference opens it: in a tab of the
 * window ("New tab", an editor tab of tabs.ts) or in a window of its own ("New window", desktop). Either way it stays
 * linked to the chart tab it came from: "Add to chart" adds to that tab's focused chart, the status bar says
 * "Linked", and "Unlinked" once that tab or its window is closed. "In-place" puts it back under the chart.
 *
 * A window of its own runs its own page (index.html?view=oakscript, OakScriptWindow.tsx) and asks its chart window
 * over app events: `LINK_REQUEST` (editor → chart window: hello, add/toggle a study, logs, in-place, and what the
 * chart window's script runtime must know: a script compiled or renamed) and `LINK_STATE` (chart window →
 * editor: the linked tab's studies, null when the tab is gone). The scripts themselves are shared through kv.
 */
import { createEffect, createSignal, onCleanup } from "solid-js";
import { emitTo, listen } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import * as kv from "../../data/kv";
import { translateWith } from "../../i18n/translator";
import { currentWindowLabel, EDITOR_WINDOW_PREFIX, isTauri } from "../shell/window-bridge";

export type DetachMode = "window" | "tab";

/** Editor window → its chart window. */
export const LINK_REQUEST = "oakscript-link-request";
/** Chart window → an editor window. */
export const LINK_STATE = "oakscript-link-state";
/** Chart window → its editor window: show this script (the chart's "Source code", the editor button). */
export const LINK_SHOW = "oakscript-link-show";

export type LinkRequest = { from: string; tab: string } & (
  | { op: "hello" | "bye" }
  | { op: "toggle" | "add"; typeId: string }
  | { op: "logs" | "in-place" | "renamed"; scriptId: string }
  | { op: "compiled"; scriptId: string; source: string }
);
export type LinkState = { tab: string; indicators: string[] | null };
export type LinkShow = { tab: string; scriptId: string | null };

/** The editor window's last size (the reference keeps it; half the screen the first time). */
const SIZE_KEY = "ot:oakscript:detachedWindow";

/** The editor window of chart window `chartWindow` (one each). */
export function editorWindowLabel(chartWindow: string): string {
  return EDITOR_WINDOW_PREFIX + chartWindow;
}

/** Window title: the script, then the editor. */
export function editorWindowTitle(scriptName: string): string {
  return translateWith("{0} — OakScript Editor", scriptName);
}

/** Open this window's editor window, linked to chart tab `chartTab` (an open one is linked to it and comes to the
 *  front). False outside the desktop app. */
export async function openEditorWindow(chartTab: string, scriptName: string): Promise<boolean> {
  if (!isTauri()) return false;
  const parent = currentWindowLabel();
  const label = editorWindowLabel(parent);
  const open = await WebviewWindow.getByLabel(label);
  if (open) {
    await emitTo(label, LINK_SHOW, { tab: chartTab, scriptId: null } satisfies LinkShow);
    await open.setFocus();
    return true;
  }
  let size: { width?: unknown; height?: unknown } | null = null;
  try {
    size = JSON.parse(kv.getItem(SIZE_KEY) ?? "null");
  } catch {
    size = null;
  }
  const width = typeof size?.width === "number" ? size.width : Math.round(screen.width / 2);
  const height = typeof size?.height === "number" ? size.height : Math.round(screen.height / 2);
  const query = new URLSearchParams({ view: "oakscript", parent, tab: chartTab });
  new WebviewWindow(label, {
    url: `index.html?${query}`,
    // Centred on the chart window.
    x: Math.max(0, Math.round(window.screenX + window.outerWidth / 2 - width / 2)),
    y: Math.max(0, Math.round(window.screenY + window.outerHeight / 2 - height / 2)),
    width,
    height,
    title: editorWindowTitle(scriptName),
    focus: true,
    dragDropEnabled: false,
  });
  return true;
}

/** The editor window keeps its size for the next one. */
export function rememberEditorWindowSize(width: number, height: number): void {
  kv.setItem(SIZE_KEY, JSON.stringify({ width: Math.round(width), height: Math.round(height) }));
}

/** What the chart window does for its editor window. */
export type EditorHost = {
  /** The studies of tab `tab`'s focused chart; null when the tab is gone. */
  studiesOf: (tab: string) => string[] | null;
  toggle: (tab: string, typeId: string) => void;
  add: (tab: string, typeId: string) => void;
  logs: (tab: string, scriptId: string) => void;
  inPlace: (tab: string, scriptId: string) => void;
  /** The script runtime of this window catches up with a change made in the editor window. */
  compiled: (scriptId: string, source: string) => void;
  renamed: (scriptId: string) => void;
};

/** Chart window side: answer the editor window and keep it told of its tab's studies. Returns which tab the editor
 *  window is linked to (null: no editor window). Call under an owner (App). */
export function hostEditorWindow(host: EditorHost): () => string | null {
  const [linked, setLinked] = createSignal<{ label: string; tab: string } | null>(null);
  if (!isTauri()) return () => null;
  const send = (to: { label: string; tab: string }) =>
    void emitTo(to.label, LINK_STATE, { tab: to.tab, indicators: host.studiesOf(to.tab) } satisfies LinkState).catch(() => undefined);
  createEffect(() => {
    const to = linked();
    if (to) send(to);
  });
  const off = listen<LinkRequest>(LINK_REQUEST, (e) => {
    const r = e.payload;
    if (r.from !== editorWindowLabel(currentWindowLabel())) return;
    switch (r.op) {
      case "hello":
        setLinked({ label: r.from, tab: r.tab });
        break;
      case "bye":
        setLinked(null);
        break;
      case "toggle":
        host.toggle(r.tab, r.typeId);
        break;
      case "add":
        host.add(r.tab, r.typeId);
        break;
      case "logs":
        host.logs(r.tab, r.scriptId);
        break;
      case "in-place":
        setLinked(null);
        host.inPlace(r.tab, r.scriptId);
        break;
      case "compiled":
        host.compiled(r.scriptId, r.source);
        break;
      case "renamed":
        host.renamed(r.scriptId);
        break;
    }
  });
  onCleanup(() => void off.then((f) => f()));
  return () => linked()?.tab ?? null;
}

/** Ask this chart window's editor window to show script `scriptId` and come to the front. */
export async function showInEditorWindow(tab: string, scriptId: string | null): Promise<void> {
  const label = editorWindowLabel(currentWindowLabel());
  const win = await WebviewWindow.getByLabel(label);
  if (!win) return;
  await emitTo(label, LINK_SHOW, { tab, scriptId } satisfies LinkShow);
  await win.setFocus();
}
