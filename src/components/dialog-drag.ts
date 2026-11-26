/*
 * Dragging a dialog by its title bar (#185), for every dialog with one (the symbol search has none to drag, as in the
 * reference app). A reopened dialog is centred again, the pointer stays 20 px inside the window (measured on the
 * reference app). The offset is never a transform (`translate` included): a transformed dialog becomes the box its
 * fixed-position menus are placed in, so a drop-down placed at the button's window position would open away from it
 * (#416). A dialog in the flow moves by `left`/`top` (made relative), an absolute or fixed one by its margins.
 */

/** Title bars that move their dialog: the Dialog shell marks its title bar, a dialog with its own frame marks it
 *  by hand. */
const TITLE_BARS = "[data-dialog-title]";

/** Controls inside a title bar keep their click. */
const CONTROLS = "button,input,select,textarea,a,[role=button],[role=tab],[contenteditable=true]";

/** Margin of the pointer inside the window while dragging. */
const POINTER_MARGIN = 20;

const offsets = new WeakMap<HTMLElement, { x: number; y: number }>();
const movers = new WeakMap<HTMLElement, (x: number, y: number) => void>();

/** Moves the dialog by an offset from where its own styles place it, read once, before its first move. */
export function moverOf(dialog: HTMLElement): (x: number, y: number) => void {
  const known = movers.get(dialog);
  if (known) return known;
  const cs = getComputedStyle(dialog);
  const px = (v: string) => parseFloat(v) || 0;
  let move: (x: number, y: number) => void;
  if (cs.position === "absolute" || cs.position === "fixed") {
    // Its left/top may be the code's (a popup placed at its button); the margins are left to us.
    const left = px(cs.marginLeft);
    const top = px(cs.marginTop);
    move = (x, y) => {
      dialog.style.marginLeft = `${left + x}px`;
      dialog.style.marginTop = `${top + y}px`;
    };
  } else {
    const relative = cs.position === "relative";
    const left = relative ? px(cs.left) : 0;
    const top = relative ? px(cs.top) : 0;
    if (!relative) dialog.style.position = "relative";
    move = (x, y) => {
      dialog.style.left = `${left + x}px`;
      dialog.style.top = `${top + y}px`;
    };
  }
  movers.set(dialog, move);
  return move;
}

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
  const move = moverOf(dialog);
  const down = { x: e.clientX, y: e.clientY };
  const onMove = (ev: MouseEvent) => {
    const at = clampPointer(ev.clientX, ev.clientY, window.innerWidth, window.innerHeight);
    const next = { x: start.x + at.x - down.x, y: start.y + at.y - down.y };
    offsets.set(dialog, next);
    move(next.x, next.y);
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
