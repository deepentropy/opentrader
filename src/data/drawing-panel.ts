/*
 * Drawing-panel visibility — the "Drawings panel" toggle in the profile/main
 * menu shows or hides the left vertical drawing toolbar. Module-level Solid
 * signal + localStorage persistence (mirrors layout-sync), so the ProfileMenu
 * toggle and App's toolbar render read the same state without prop-threading.
 */
import { createSignal } from "solid-js";
import * as kv from "./kv";

const STORAGE_KEY = "ot:drawing-panel-visible";

function load(): boolean {
  try {
    const raw = kv.getItem(STORAGE_KEY);
    if (raw != null) return raw === "1";
  } catch {
    /* malformed / unavailable — default to visible */
  }
  return true;
}

const [drawingPanelVisible, setDrawingPanelVisibleRaw] = createSignal<boolean>(load());

// Live cross-window sync: re-seed from storage on another window's change.
kv.onExternalChange(STORAGE_KEY, () => setDrawingPanelVisibleRaw(load()));

export { drawingPanelVisible };

export function setDrawingPanelVisible(visible: boolean): void {
  setDrawingPanelVisibleRaw(visible);
  try {
    kv.setItem(STORAGE_KEY, visible ? "1" : "0");
  } catch {
    /* best-effort */
  }
}

export function toggleDrawingPanel(): void {
  setDrawingPanelVisible(!drawingPanelVisible());
}
