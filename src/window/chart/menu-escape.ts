/*
 * The Escape that closes a chart context menu only closes the menu: a study
 * selected before it stays selected, and so does it on the next Escape; the
 * one after clears it. A click in between ends that (reference behaviour).
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

/** Asked by an Escape that would clear the selection: true when it closes a menu or is the one right after. */
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
