/*
 * MainMenu — the window's menu, opened by the main-menu button of the title
 * bar (TabPanelActions). As in the reference desktop app: Settings, New tab,
 * New window, Reopen closed tab, Open link from clipboard | Zoom | the theme
 * tiles | Exit. Language and the drawings panel stay in the account menu
 * (ProfileMenu), so no row is in both.
 *
 * "Open link from clipboard" opens a link the app knows (a Community post,
 * deep-link.ts); it is greyed out when the clipboard holds anything else, read
 * when the menu opens. Zoom and Exit are the desktop app's (app_menu.rs).
 */
import { createSignal, For, onMount, Show } from "solid-js";
import { Icon } from "../../components/Icon";
import { createPopover } from "../../components/popover";
import { startAlignedClamped } from "../../components/reading-direction";
import { commands } from "../../bindings";
import { installUpdate, updateReady } from "../../data/app-update";
import { stepZoom, zoom, zoomPercent } from "../../data/app-zoom";
import { postOfLink } from "../../data/community/deep-link";
import { requestOpenPost } from "../../data/community/notifications";
import { ThemePicker } from "../header/AppSettingsDialog";
import type { ThemeSetting } from "./app-theme";
import { setActiveRailTab } from "./app-dialogs";
import { isTauri, openNewWindow } from "./window-bridge";

export type MainMenuAction = "app-settings" | "new-tab" | "reopen-closed";

type Row = { label: string; icon: string; hotkey?: string; disabled?: boolean; run: () => void };

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

function MenuRow(props: { row: Row; onClose: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      class="profile-menu-row"
      disabled={props.row.disabled}
      onClick={() => {
        props.row.run();
        props.onClose();
      }}
    >
      <span class="profile-menu-icon"><Icon name={props.row.icon} size={18} /></span>
      <span class="profile-menu-label">{props.row.label}</span>
      <Show when={props.row.hotkey}><span class="profile-menu-hotkey" data-no-translate>{props.row.hotkey}</span></Show>
    </button>
  );
}

export function MainMenu(props: Props) {
  const desktop = isTauri();
  // Outside-click / Esc dismiss; clicks on the opening button toggle through its own onClick.
  const popover = createPopover(undefined, {
    onClose: () => props.onClose(),
    placement: false,
    insideSelector: ".main-menu-button",
    escape: "pass",
    on: { target: "window", capture: false },
  });

  // The post of the link on the clipboard, read once the menu is open (by the
  // desktop app: the webview's clipboard API wants focus and may ask permission).
  const [clipPost, setClipPost] = createSignal<string | null>(null);
  onMount(() => {
    const text = desktop ? commands.appClipboardText() : navigator.clipboard?.readText();
    void text?.then((t) => setClipPost(t ? postOfLink(t) : null), () => setClipPost(null));
  });

  const rows = (): Row[] => {
    const out: Row[] = [
      { label: "Settings", icon: "profile-app-settings", hotkey: "Ctrl + ,", run: () => props.onAction("app-settings") },
      { label: "New tab", icon: "tab-new", hotkey: "Ctrl + T", run: () => props.onAction("new-tab") },
    ];
    // Windows are the desktop app's.
    if (desktop) out.push({ label: "New window", icon: "tab-new-window", hotkey: "Ctrl + N", run: () => void openNewWindow() });
    const reopen = props.reopenLabel;
    if (reopen) out.push({ label: reopen, icon: "main-menu-reopen", hotkey: "Ctrl + Shift + T", run: () => props.onAction("reopen-closed") });
    out.push({
      label: "Open link from clipboard",
      icon: "main-menu-open-link",
      disabled: clipPost() === null,
      run: () => {
        const id = clipPost();
        if (!id) return;
        setActiveRailTab("community");
        requestOpenPost(id, { openChart: true });
      },
    });
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
      <For each={rows()}>{(r) => <MenuRow row={r} onClose={props.onClose} />}</For>
      <div class="profile-menu-sep" />
      {/* Zoom: every window, 10 % a step; the menu stays open. */}
      <Show when={desktop}>
        <div class="main-menu-zoom">
          <span class="profile-menu-icon"><Icon name="header-fullscreen-mode" size={18} /></span>
          <span class="profile-menu-label">Zoom</span>
          <button type="button" class="main-menu-zoom-step" aria-label="Zoom out" onClick={() => void stepZoom(-1)}>
            <Icon name="main-menu-zoom-out" size={18} />
          </button>
          <span class="main-menu-zoom-value ot-value" data-no-translate>{zoomPercent(zoom())}%</span>
          <button type="button" class="main-menu-zoom-step" aria-label="Zoom in" onClick={() => void stepZoom(1)}>
            <Icon name="main-menu-zoom-in" size={18} />
          </button>
        </div>
        <div class="profile-menu-sep" />
      </Show>
      {/* Picking a theme applies it at once; the menu stays open. */}
      <div class="main-menu-theme">
        <ThemePicker compact setting={props.themeSetting} onChange={props.onThemeChange} />
      </div>
      <Show when={desktop}>
        <div class="profile-menu-sep" />
        <MenuRow row={{ label: "Exit OpenTrader", icon: "profile-sign-out", hotkey: "Ctrl + Shift + Q", run: () => void commands.appQuit() }} onClose={props.onClose} />
      </Show>
    </div>
  );
}
