/*
 * Web version: a new build of the site is out and this page's files are gone from the server (src/data/new-build.ts),
 * so what loads on demand (studies' workers, panels) fails until the page is reloaded.
 */
import { Show } from "solid-js";
import { dismissNewBuild, newBuild } from "../../data/new-build";

export function NewBuildBanner() {
  return (
    <Show when={newBuild()}>
      <div class="ot-update-required" role="alert">
        <span>A new version of OpenTrader is available. Reload the page to use it.</span>
        <button type="button" onClick={() => location.reload()}>
          Reload
        </button>
        <button type="button" class="ot-update-required-close" aria-label="Close" onClick={dismissNewBuild}>
          ×
        </button>
      </div>
    </Show>
  );
}
