/*
 * The web view's own right-click menu (Back, Reload, Save as, Print…) is not
 * part of the app: a right-click that no app menu takes shows nothing. Text
 * fields keep it, for cut, copy and paste.
 */

/** Text that takes typing: inputs that are not buttons, checks or ranges. */
const TEXT_FIELD =
  'textarea, [contenteditable=""], [contenteditable="true"], input:not([type]), ' +
  'input[type="text"], input[type="search"], input[type="number"], input[type="email"], ' +
  'input[type="url"], input[type="tel"], input[type="password"]';

export function blocksBrowserMenu(target: EventTarget | null): boolean {
  const el = target as Partial<Pick<Element, "closest">> | null;
  return !el?.closest?.(TEXT_FIELD);
}

export function installBrowserMenuBlock(): void {
  document.addEventListener("contextmenu", (e) => {
    if (blocksBrowserMenu(e.target)) e.preventDefault();
  });
}
