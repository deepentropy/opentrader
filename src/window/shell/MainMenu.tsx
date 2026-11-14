/*
 * MainMenu — the window's menu, opened by the main-menu button of the title
 * bar (TabPanelActions). As in the reference desktop app it holds the window's
 * rows (Settings, New tab, New window, Reopen closed tab) and the theme tiles;
 * Language and the drawings panel stay in the account menu (ProfileMenu), so
 * no row is in both.
 */
import { For, Show } from "solid-js";
import { Icon } from "../../components/Icon";
import { createPopover } from "../../components/popover";
import { startAlignedClamped } from "../../components/reading-direction";
import { installUpdate, updateReady } from "../../data/app-update";
import { ThemePicker } from "../header/AppSettingsDialog";
import type { ThemeSetting } from "./app-theme";
import { isTauri, openNewWindow } from "./window-bridge";

export type MainMenuAction = "app-settings" | "new-tab" | "reopen-closed";

type Row = { label: string; icon: string; hotkey: string; run: () => void };

const WIDTH = 260;

type Props = {
  anchor: DOMRect;
  onClose: () => void;
  onAction: (action: MainMenuAction) => void;
  /** "Reopen closed tab" / "Reopen closed window"; null: nothing to reopen, no row. */
  reopenLabel?: string | null;
  themeSetting: ThemeSetting;
  onThemeChange: (s: ThemeSetting) => void;
};

export function MainMenu(props: Props) {
  // Outside-click / Esc dismiss; clicks on the opening button toggle through its own onClick.
  const popover = createPopover(undefined, {
    onClose: () => props.onClose(),
    placement: false,
    insideSelector: ".main-menu-button",
    escape: "pass",
    on: { target: "window", capture: false },
  });

  const rows = (): Row[] => {
    const out: Row[] = [
      { label: "Settings", icon: "profile-app-settings", hotkey: "Ctrl + ,", run: () => props.onAction("app-settings") },
      { label: "New tab", icon: "tab-new", hotkey: "Ctrl + T", run: () => props.onAction("new-tab") },
    ];
    // Windows are the desktop app's.
    if (isTauri()) out.push({ label: "New window", icon: "tab-new-window", hotkey: "Ctrl + N", run: () => void openNewWindow() });
    const reopen = props.reopenLabel;
    if (reopen) out.push({ label: reopen, icon: "main-menu-reopen", hotkey: "Ctrl + Shift + T", run: () => props.onAction("reopen-closed") });
    return out;
  };

  return (
    <div
      ref={popover}
      class="ot-popover profile-menu main-menu"
      role="menu"
      aria-label="Main menu"
      style={{
        position: "fixed",
        left: `${Math.round(startAlignedClamped(props.anchor, WIDTH, window.innerWidth, 8))}px`,
        top: `${Math.round(props.anchor.bottom + 4)}px`,
        "z-index": 1000,
      }}
    >
      {/* Update downloaded: the reference app's "Relaunch to update" row, above Settings. */}
      <Show when={updateReady()}>
        <button
          type="button"
          role="menuitem"
          class="update-app-menu-item available"
          onClick={() => {
            installUpdate();
            props.onClose();
          }}
        >
          <Icon name="update-app-check" size={28} />
          <span>Relaunch to update</span>
        </button>
      </Show>
      <For each={rows()}>
        {(r) => (
          <button
            type="button"
            role="menuitem"
            class="profile-menu-row"
            onClick={() => {
              r.run();
              props.onClose();
            }}
          >
            <span class="profile-menu-icon"><Icon name={r.icon} size={18} /></span>
            <span class="profile-menu-label">{r.label}</span>
            <span class="profile-menu-hotkey" data-no-translate>{r.hotkey}</span>
          </button>
        )}
      </For>
      <div class="profile-menu-sep" />
      {/* Picking a theme applies it at once; the menu stays open. */}
      <div class="main-menu-theme">
        <ThemePicker compact setting={props.themeSetting} onChange={props.onThemeChange} />
      </div>
    </div>
  );
}
