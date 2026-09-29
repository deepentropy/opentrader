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
  const { render } = await import("solid-js/web");
  const { default: App } = await import("./App");
  render(() => <App />, document.getElementById("root") as HTMLElement);
  hideSplash();
});

/** Fade out the startup splash (index.html) once the App has rendered. */
function hideSplash(): void {
  const splash = document.getElementById("splash");
  if (!splash) return;
  splash.classList.add("is-hidden");
  splash.addEventListener("transitionend", () => splash.remove(), { once: true });
}
