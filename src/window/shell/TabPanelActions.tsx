/*
 * TabPanelActions — the cluster between the tabs and the window controls in
 * the merged title bar (`tab-panel-actions`); we ship the
 * main-menu button (meatballs glyph for a signed-in user) which opens the
 * account / app main menu (reusing the header's ProfileMenu).
 */
import { createSignal, Show } from "solid-js";
import { Icon } from "../../components/Icon";
import { Tooltip } from "../../components/Tooltip";
import { ProfileMenu } from "../header/ProfileMenu";
import { isTauri, openNewWindow } from "./window-bridge";

type Props = {
  userName?: string;
  /** Open App Settings (ProfileMenu's "app-settings" row). */
  onOpenAppSettings?: () => void;
  /** "Reopen closed tab" / "Reopen closed window" (null: nothing to reopen). */
  reopenLabel?: string | null;
  onReopen?: () => void;
};

export function TabPanelActions(props: Props) {
  const [anchor, setAnchor] = createSignal<DOMRect | null>(null);
  const userName = () => props.userName ?? "Trader";

  return (
    <div class="tab-panel-actions">
      {/* Market data delay notice (the gateway serves 15-minute delayed data). */}
      <Tooltip text="Market data is delayed by 15 minutes." side="bottom">
        <span class="data-delay-badge" data-qa-id="data-delay-badge">Delayed 15 min</span>
      </Tooltip>
      {/* New window (Ctrl+N) — multi-window only, so hidden off-shell. */}
      <Show when={isTauri()}>
        <button
          type="button"
          class="action-button new-window-button"
          data-qa-id="new-window-button"
          title="New window"
          aria-label="New window"
          onClick={() => openNewWindow()}
        >
          <Icon name="tab-new-window" size={28} />
        </button>
      </Show>
      <button
        type="button"
        class={"action-button main-menu-button" + (anchor() ? " opened" : "")}
        data-qa-id="main-menu-button"
        title="Main menu"
        aria-label="Main menu"
        aria-haspopup="menu"
        onClick={(e) =>
          setAnchor((cur) => (cur ? null : e.currentTarget.getBoundingClientRect()))
        }
      >
        <Icon name="main-menu-meatballs" size={28} />
      </button>
      <Show when={anchor()}>
        {(a) => (
          <ProfileMenu
            anchor={a()}
            userName={userName()}
            onClose={() => setAnchor(null)}
            reopenLabel={props.reopenLabel}
            onAction={(action) => {
              if (action === "app-settings") props.onOpenAppSettings?.();
              if (action === "reopen-closed") props.onReopen?.();
            }}
          />
        )}
      </Show>
    </div>
  );
}
