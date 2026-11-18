/*
 * Web version: a new build of the site was deployed while this page stayed open (#362). The old build's files are gone
 * from the server, so a worker or a part of the code loaded on demand cannot load any more: studies stay empty, a
 * panel does not open. When such a load fails, the site's page is read again; if it no longer loads this page's
 * script, the window offers to reload (NewBuildBanner). The layout is saved as it changes, so a reload loses nothing.
 */
import { createSignal } from "solid-js";

const WEB = import.meta.env.MODE === "web";

const [shown, setShown] = createSignal(false);
/** A newer build is on the server: the banner shows. */
export const newBuild = shown;
export const dismissNewBuild = (): void => void setShown(false);

let asked: Promise<boolean> | null = null;

/** This page's entry script, as the built page names it (`/assets/index-….js`). */
function entryScript(): string | null {
  return document.querySelector<HTMLScriptElement>('script[type="module"][src]')?.getAttribute("src") ?? null;
}

/** Web version: is the build on the server another than this page's? Answers false when the page cannot be read. */
export function checkNewBuild(): Promise<boolean> {
  if (!WEB || typeof document === "undefined") return Promise.resolve(false);
  if (shown()) return Promise.resolve(true);
  const entry = entryScript();
  if (!entry) return Promise.resolve(false);
  // Several loads fail together (a pool of workers, chunks): one read of the page for all of them.
  asked ??= (async () => {
    try {
      const res = await fetch("/", { cache: "no-store" });
      if (!res.ok) return false;
      const changed = !(await res.text()).includes(entry);
      if (changed) setShown(true);
      return changed;
    } catch {
      return false;
    } finally {
      asked = null;
    }
  })();
  return asked;
}

/** Code loaded on demand that did not load (the bundler's `vite:preloadError`): maybe a new build. */
export function installNewBuildCheck(): void {
  if (!WEB) return;
  window.addEventListener("vite:preloadError", () => void checkNewBuild());
}
