/*
 * WindowControls — minimize / maximize-restore / close buttons for the
 * frameless window. Now that native decorations are off (tauri.conf.json),
 * these live at the right edge of the `.tab-bar`, merging the OS title bar
 * into the chart-tab strip.
 *
 * Tauri-only: outside the shell (plain browser / verify harness) the native
 * chrome — if any — still applies, so we render nothing and stay a no-op.
 */
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri } from "./window-bridge";

export function WindowControls() {
  if (!isTauri()) return null;

  const appWindow = getCurrentWindow();
  const [maximized, setMaximized] = createSignal(false);

  const sync = () => appWindow.isMaximized().then(setMaximized).catch(() => {});

  onMount(() => {
    void sync();
    // Track OS-driven size changes (snap, drag-to-edge, double-click) so the
    // maximize/restore glyph stays correct.
    const unlisten = appWindow.onResized(() => void sync());
    onCleanup(() => void unlisten.then((f) => f()).catch(() => {}));
  });

  return (
    <div class="window-controls">
      <button
        class="window-control"
        aria-label="Minimize"
        title="Minimize"
        tabIndex={-1}
        onClick={() => void appWindow.minimize()}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <rect x="0" y="4.5" width="10" height="1" fill="currentColor" />
        </svg>
      </button>
      <button
        class="window-control"
        aria-label={maximized() ? "Restore" : "Maximize"}
        title={maximized() ? "Restore" : "Maximize"}
        tabIndex={-1}
        onClick={() => void appWindow.toggleMaximize()}
      >
        <Show
          when={maximized()}
          fallback={
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" />
            </svg>
          }
        >
          {/* Restore — two offset squares. */}
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <rect x="0.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" />
            <path d="M2.5 2.5V0.5H9.5V7.5H7.5" fill="none" stroke="currentColor" />
          </svg>
        </Show>
      </button>
      <button
        class="window-control window-control-close"
        aria-label="Close"
        tabIndex={-1}
        onClick={() => void appWindow.close()}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0.5 0.5L9.5 9.5M9.5 0.5L0.5 9.5" stroke="currentColor" />
        </svg>
      </button>
    </div>
  );
}
