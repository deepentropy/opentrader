/*
 * ScreenerWindow: the screener in a window of its own (placement "Separate
 * window", desktop). The window holds the screener panel only: its header is
 * the title bar (dragged to move the window), Close closes the window, and a
 * row pick changes the chart of the main window (event
 * SCREENER_PICK_EVENT, handled by App).
 */
import { onMount } from "solid-js";
import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { createAppTheme } from "../shell/app-theme";
import { currentWindowLabel } from "../shell/window-bridge";
import { ScreenerPanel } from "./ScreenerPanel";

/** Event to the main window: a symbol picked in the screener window ({ ticker }). */
export const SCREENER_PICK_EVENT = "screener-symbol-picked";

export function ScreenerWindow() {
  const { observeTheme } = createAppTheme();
  onMount(observeTheme);
  return (
    <div class="screener-window">
      <ScreenerPanel
        windowLabel={currentWindowLabel()}
        dock="window"
        onSymbolPicked={(ticker) => void emitTo("main", SCREENER_PICK_EVENT, { ticker })}
        onCloseWindow={() => void getCurrentWebviewWindow().close()}
      />
    </div>
  );
}
