/*
 * Dragging a dialog by its title bar (#185), for every dialog with one (the symbol search has none to drag, as in the
 * reference app). A reopened dialog is centred again, the pointer stays 20 px inside the window (measured on the
 * reference app). The offset is the CSS `translate` property: it adds to the dialog's own layout and transforms.
 */

/** Title bars that move their dialog. */
const TITLE_BARS = [
  ".cp3-header",
  ".indicators-header",
  ".layout-browser-header",
  ".ad-header",
  ".wl-dialog-header",
  ".goto-dialog-titlebar",
  ".drawing-settings-header",
  ".sid-header",
  ".app-settings-header",
  ".ot-dlg-title",
  ".layout-name-titlebar",
  ".oak-builtin-dlg__title",
  ".rs-header",
  ".re-header",
  ".scr-open-header",
].join(",");

/** Controls inside a title bar keep their click. */
const CONTROLS = "button,input,select,textarea,a,[role=button],[role=tab],[contenteditable=true]";

/** Margin of the pointer inside the window while dragging. */
const POINTER_MARGIN = 20;

const offsets = new WeakMap<HTMLElement, { x: number; y: number }>();

/** Pointer position kept inside the window. */
export function clampPointer(x: number, y: number, width: number, height: number): { x: number; y: number } {
  return {
    x: Math.min(Math.max(x, POINTER_MARGIN), width - POINTER_MARGIN),
    y: Math.min(Math.max(y, POINTER_MARGIN), height - POINTER_MARGIN),
  };
}

function onMouseDown(e: MouseEvent) {
  if (e.button !== 0) return;
  const target = e.target as Element | null;
  if (!target?.closest || target.closest(CONTROLS) || !target.closest(TITLE_BARS)) return;
  const dialog = target.closest<HTMLElement>("[role=dialog]");
  if (!dialog) return;
  e.preventDefault();
  const start = offsets.get(dialog) ?? { x: 0, y: 0 };
  const down = { x: e.clientX, y: e.clientY };
  const onMove = (ev: MouseEvent) => {
    const at = clampPointer(ev.clientX, ev.clientY, window.innerWidth, window.innerHeight);
    const next = { x: start.x + at.x - down.x, y: start.y + at.y - down.y };
    offsets.set(dialog, next);
    dialog.style.translate = `${next.x}px ${next.y}px`;
  };
  const onUp = () => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
  };
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}

/** Starts the dragging for this window; returns the cleanup. */
export function installDialogDrag(): () => void {
  // Capture: the dialogs stop the event from reaching the document.
  document.addEventListener("mousedown", onMouseDown, true);
  return () => document.removeEventListener("mousedown", onMouseDown, true);
}
