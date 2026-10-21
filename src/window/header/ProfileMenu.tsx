/*
 * ProfileMenu — the account/main menu dropdown opened by the circular avatar
 * button at the far left of the header toolbar. Solid port of the reference
 * mock's ProfileMenu (260px, grouped rows starting at Home).
 *
 * Rows are presentational (close on click) except "Settings" (fires the
 * `app-settings` action), "App onboarding..." (desktop app: opens the
 * onboarding dialog, as the reference app's support menu does) and the
 * "Drawings panel" toggle, which shows/hides the left drawing toolbar via the
 * shared `drawing-panel` signal (persisted).
 */
import { For, onCleanup, onMount, Show } from "solid-js";
import { Icon } from "../../components/Icon";
import { drawingPanelVisible, toggleDrawingPanel } from "../../data/drawing-panel";
import { installUpdate, updateReady } from "../../data/app-update";
import { setOnboardingOpen } from "../shell/app-dialogs";
import { isTauri } from "../shell/window-bridge";

type Row =
  | { type: "sep" }
  | {
      type: "item";
      label: string;
      icon?: string;
      value?: string;
      hotkey?: string;
      submenu?: boolean;
      toggle?: boolean;
      danger?: boolean;
      action?: string;
    };

const SETTINGS_ROW: Row = { type: "item", label: "Settings", icon: "profile-app-settings", hotkey: "Ctrl + ,", action: "app-settings" };
const ONBOARDING_ROW: Row = { type: "item", label: "App onboarding...", icon: "main-menu-onboarding", action: "app-onboarding" };
const DRAWINGS_ROW: Row = { type: "item", label: "Drawings panel", icon: "profile-drawings", toggle: true };

/** Settings, App onboarding... (desktop app), the reopen row (Ctrl + Shift + T)
 *  when there is something to reopen, Drawings panel. */
function rows(reopen: string | null | undefined): Row[] {
  const out: Row[] = [SETTINGS_ROW];
  if (isTauri()) out.push(ONBOARDING_ROW);
  if (reopen) out.push({ type: "item", label: reopen, icon: "main-menu-reopen", hotkey: "Ctrl + Shift + T", action: "reopen-closed" });
  out.push(DRAWINGS_ROW);
  return out;
}

type Props = {
  anchor: DOMRect;
  userName: string;
  /** Plan label shown in the top badge (e.g. "Free", "Premium"). */
  plan?: string;
  onClose: () => void;
  /** Fired with a row's `action` id (e.g. 'app-settings') before close. */
  onAction?: (action: string) => void;
  /** Desktop main menu only: label of the undo row ("Reopen closed tab" /
   *  "Reopen closed window", after New window). Absent or null: no row. */
  reopenLabel?: string | null;
};

/** No-photo avatar colour: hsl(<hash-of-name>, 25%, 50%). */
export function avatarHue(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return h;
}

export function ProfileMenu(props: Props) {
  let root!: HTMLDivElement;

  onMount(() => {
    // Outside-click / Esc dismiss. Ignore clicks on the avatar button — its own
    // onClick handles the toggle, so we'd double-fire otherwise.
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (root.contains(t) || (t as Element).closest?.(".header-toolbar-profile, .main-menu-button")) return;
      props.onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") props.onClose(); };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    onCleanup(() => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    });
  });

  return (
    <div
      ref={root}
      class="ot-popover profile-menu"
      role="menu"
      aria-label="Main menu"
      style={{ position: "fixed", left: `${Math.round(Math.max(8, Math.min(props.anchor.left, window.innerWidth - 260 - 8)))}px`, top: `${Math.round(props.anchor.bottom + 4)}px`, "z-index": 1000 }}
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
      <For each={rows(props.reopenLabel)}>
        {(r) => (
          <Show when={r.type === "item" ? (r as Extract<Row, { type: "item" }>) : null} fallback={<div class="profile-menu-sep" />}>
            {(item) => (
              <button
                type="button"
                role="menuitem"
                class={`profile-menu-row${item().danger ? " is-danger" : ""}`}
                onClick={(e) => {
                  if (item().toggle) {
                    e.stopPropagation();
                    toggleDrawingPanel();
                    return;
                  }
                  if (item().action === "app-onboarding") setOnboardingOpen(true);
                  else if (item().action) props.onAction?.(item().action!);
                  props.onClose();
                }}
              >
                <span class="profile-menu-icon"><Show when={item().icon}>{(ic) => <Icon name={ic()} size={18} />}</Show></span>
                <span class="profile-menu-label">{item().label}</span>
                <Show when={item().value}><span class="profile-menu-value">{item().value}</span></Show>
                <Show when={item().hotkey}><span class="profile-menu-hotkey">{item().hotkey}</span></Show>
                <Show when={item().toggle}>
                  <span class={`profile-menu-toggle${drawingPanelVisible() ? " is-on" : ""}`} aria-hidden="true">
                    <span class="profile-menu-toggle-knob" />
                  </span>
                </Show>
                <Show when={item().submenu}><span class="profile-menu-arrow" aria-hidden="true">›</span></Show>
              </button>
            )}
          </Show>
        )}
      </For>
    </div>
  );
}
