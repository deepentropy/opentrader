/*
 * The AI assistant panel at the window's right, as the reference app's: an overlay over the charts (the default) or a
 * split view the charts shrink for ("Move overlay to split-view"), its width dragged on its left edge, and "Collapse
 * panel" (it closes, the rail button keeps a dot). Kept in kv, but whether it shows starts closed.
 */
import { createRoot, createSignal } from "solid-js";
import * as kv from "../kv";

export type AssistantMode = "overlay" | "split";
export const ASSISTANT_MIN_WIDTH = 360;

const MODE_KEY = "ot:assistant:mode";
const WIDTH_KEY = "ot:assistant:width";

const panel = createRoot(() => {
  const [open, setOpen] = createSignal(false);
  const [collapsed, setCollapsed] = createSignal(false);
  const [mode, setMode] = createSignal<AssistantMode>(kv.getItem(MODE_KEY) === "split" ? "split" : "overlay");
  const w = Number(kv.getItem(WIDTH_KEY));
  const [width, setWidth] = createSignal<number | null>(Number.isFinite(w) && w >= ASSISTANT_MIN_WIDTH ? w : null);
  return { open, setOpen, collapsed, setCollapsed, mode, setMode, width, setWidth };
});

export const assistantPanel = {
  open: panel.open,
  collapsed: panel.collapsed,
  setOpen(v: boolean): void {
    panel.setOpen(v);
    panel.setCollapsed(false);
  },
  toggle(): void {
    assistantPanel.setOpen(!panel.open());
  },
  /** Collapse panel: it closes and the rail button keeps a dot until it opens or closes again. */
  collapse(): void {
    panel.setOpen(false);
    panel.setCollapsed(true);
  },
  mode: panel.mode,
  setMode(m: AssistantMode): void {
    panel.setMode(m);
    kv.setItem(MODE_KEY, m);
  },
  /** The width dragged last; none = half the window (the reference app). */
  width: (): number => panel.width() ?? Math.max(ASSISTANT_MIN_WIDTH, Math.round(document.documentElement.clientWidth / 2)),
  /** Live width while dragging; `commit` persists it. */
  setWidth(px: number, commit = false): void {
    panel.setWidth(Math.max(ASSISTANT_MIN_WIDTH, Math.round(px)));
    if (commit) kv.setItem(WIDTH_KEY, String(panel.width()));
  },
};
