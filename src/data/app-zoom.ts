/*
 * The app zoom (#335): the main menu's Zoom row and Ctrl + = / - / 0 zoom
 * every window by 10 % steps, from 20 % to 500 % (src-tauri/src/app_menu.rs
 * applies it). It lasts for the run, as in the reference app. The window that
 * changes it shows "Zoom 110%" for 2 s at its top (ZoomToast).
 * Desktop app only: in a browser, the browser zooms.
 */
import { createSignal } from "solid-js";
import { commands, events } from "../bindings";
import { isTauri } from "../window/shell/window-bridge";

const STEP = 0.1;
const TOAST_MS = 2000;

const [zoom, setZoom] = createSignal(1);
const [toastShown, setToastShown] = createSignal(false);
let toastTimer: ReturnType<typeof setTimeout> | undefined;

/** The zoom, as a factor (1 = 100 %). */
export { zoom };
/** The zoom toast is on screen in this window. */
export { toastShown as zoomToastShown };

/** Percent shown for a factor: 1.1 → 110. */
export const zoomPercent = (factor: number): number => Math.round(factor * 100);

let started = false;
/** Take the run's zoom (a window opened after a change) and follow changes. */
export function initAppZoom(): void {
  if (started || !isTauri()) return;
  started = true;
  void commands.appZoomGet().then((z) => { if (z != null) setZoom(z); });
  void events.appZoomChanged.listen((e) => { if (e.payload.zoom != null) setZoom(e.payload.zoom); });
}

function showToast() {
  setToastShown(true);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => setToastShown(false), TOAST_MS);
}

async function apply(factor: number): Promise<void> {
  if (!isTauri()) return;
  const z = await commands.appZoomSet(factor);
  if (z == null) return;
  setZoom(z);
  showToast();
}

/** One step in (+1) or out (-1). */
export const stepZoom = (dir: 1 | -1): Promise<void> => apply(zoom() + dir * STEP);
/** Back to 100 %. */
export const resetZoom = (): Promise<void> => apply(1);
