/* @refresh reload */
import "./styles.css";
import { hydrateKv } from "./data/kv";
import { installOverflowTooltip } from "./components/overflow-tooltip";

// A tooltip on menu labels only when they are cut.
installOverflowTooltip();

// Hydrate the persistence layer BEFORE App (and its module graph) loads: many
// modules seed signals/stores from kv synchronously at import time, so the
// in-memory mirror must be populated first. App is dynamically imported so its
// dependency graph isn't evaluated until hydration resolves. hydrateKv always
// resolves (it falls back to localStorage on failure), so .finally is enough.
void hydrateKv().finally(async () => {
  // Restart: main may take over a saved window's tabs (window session).
  const { adoptSavedWindowTabs } = await import("./window/shell/window-bridge");
  await adoptSavedWindowTabs();
  // Update state for the title bar, main menu and Settings > About.
  const { initAppUpdate } = await import("./data/app-update");
  initAppUpdate();
  const { render } = await import("solid-js/web");
  const { default: App } = await import("./App");
  render(() => <App />, document.getElementById("root") as HTMLElement);
  hideSplash();
});

/** Minimum time the startup splash stays up, from page start, so its delay
 *  warning can be read. The App renders and loads data underneath meanwhile. */
const SPLASH_MIN_MS = 1500;

/** Fade out the startup splash (index.html) once the App has rendered and the
 *  minimum time has passed. */
function hideSplash(): void {
  const splash = document.getElementById("splash");
  if (!splash) return;
  const fade = () => {
    splash.classList.add("is-hidden");
    splash.addEventListener("transitionend", () => splash.remove(), { once: true });
  };
  window.setTimeout(fade, Math.max(0, SPLASH_MIN_MS - performance.now()));
}
