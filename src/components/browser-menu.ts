/*
 * The web view's own right-click menu (Back, Reload, Save as, Print, Cut,
 * Copy, Paste…) is not part of the app: a right-click that no app menu takes
 * shows nothing. Text fields keep their keyboard shortcuts.
 */
export function installBrowserMenuBlock(): void {
  document.addEventListener("contextmenu", (e) => e.preventDefault());
}
