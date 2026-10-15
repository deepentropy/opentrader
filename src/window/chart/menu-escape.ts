/*
 * The Escape that closes a chart context menu only closes the menu. A study
 * selected before it stays selected, and so does it on the next Escape; the
 * one after clears it; a click in between ends that. A drawing stays selected
 * on that Escape only: the next one clears it (reference behaviour).
 */
let open = 0;
let skip = 0;

if (typeof document !== "undefined") {
  document.addEventListener("mousedown", () => { skip = 0; }, true);
}

/** A context menu is shown; the returned function is called when it closes. */
export function contextMenuShown(): () => void {
  open++;
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    open--;
  };
}

/** True while a context menu is shown (an Escape now closes it). */
export function contextMenuOpen(): boolean {
  return open > 0;
}

/** Asked by an Escape that would clear the study selection: true when it closes a menu or is the one right after. */
export function escapeKeepsSelection(): boolean {
  if (open > 0) {
    skip = 1;
    return true;
  }
  if (skip > 0) {
    skip--;
    return true;
  }
  return false;
}
