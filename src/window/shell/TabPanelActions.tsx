/*
 * TabPanelActions — the cluster between the tabs and the window controls in
 * the merged title bar (`tab-panel-actions`); we ship the
 * main-menu button (meatballs glyph for a signed-in user) which opens the
 * window's main menu (MainMenu).
 */
import { createEffect, createSignal, on, onMount, Show, untrack } from "solid-js";
import { Icon } from "../../components/Icon";
import { Tooltip } from "../../components/Tooltip";
import { MainMenu } from "./MainMenu";
import type { ThemeSetting } from "./app-theme";
import type { OpenedLink } from "../../data/deep-link";
import { updateReady } from "../../data/app-update";
import { zoom } from "../../data/app-zoom";
import { track } from "../../data/analytics";
import { isTauri, openNewWindow } from "./window-bridge";
import { betaEnds, betaPrompt, initPaid, paidShown, realtimeActive, realtimeElsewhere } from "../../data/paid/plan";
import { me, ready } from "../../data/community/session";
import { getItem, setItem } from "../../data/kv";
import { betaDay, betaText, showPlanDialog } from "../paid/PlanDialog";
import { translateAs, translateWith } from "../../i18n/translator";

/** The web version (`vite --mode web`): its title bar links to the desktop app. */
const WEB_BUILD = import.meta.env.MODE === "web";
const DESKTOP_DOWNLOAD_URL = "https://opentrader.markets/download.html";
/** When the live data beta was first told (ms; src/data/kv.ts), and when a signed-out user was reminded of it. */
const BETA_TOLD = "ot:live-beta-told";
const BETA_REMINDED = "ot:live-beta-reminded";

type Props = {
  /** Open App Settings (the main menu's Settings row). */
  onOpenAppSettings: () => void;
  onNewTab: () => void;
  /** "Reopen closed tab" / "Reopen closed window" (null: nothing to reopen). */
  reopenLabel?: string | null;
  onReopen: () => void;
  themeSetting: ThemeSetting;
  onThemeChange: (s: ThemeSetting) => void;
  onOpenLink: (link: OpenedLink) => void;
};

export function TabPanelActions(props: Props) {
  const [anchor, setAnchor] = createSignal<DOMRect | null>(null);
  const toggleMenu = (e: MouseEvent & { currentTarget: HTMLButtonElement }) =>
    setAnchor((cur) => (cur ? null : e.currentTarget.getBoundingClientRect()));
  // The Zoom row keeps the menu open: place it again under its button at the new zoom.
  createEffect(on(zoom, () => {
    const btn = document.querySelector<HTMLElement>(".tab-panel-actions .main-menu-button");
    if (anchor() && btn) setAnchor(btn.getBoundingClientRect());
  }, { defer: true }));
  onMount(initPaid);
  // The live data beta is told as soon as this user is on it or may sign in for it; still signed out a week later,
  // once more.
  createEffect(() => {
    if (betaEnds() === null || !ready()) return;
    const now = Date.now();
    const step = betaPrompt(getItem(BETA_TOLD), getItem(BETA_REMINDED), !me(), now);
    if (step === "tell" || step === "stamp") setItem(BETA_TOLD, String(now));
    if (step === "remind") setItem(BETA_REMINDED, String(now));
    if (step === "tell" || step === "remind") untrack(() => showPlanDialog(step === "tell" ? "notice" : "reminder"));
  });
  const badgeTip = () =>
    realtimeActive()
      ? betaEnds() !== null ? betaText(betaEnds()!) : "Market data is live."
      : realtimeElsewhere()
        ? "Live data is in use on another device. Click to use it here."
        : betaEnds() !== null
          ? translateWith("Market data is delayed by 15 minutes. Sign in to get live data, free during the beta until {0}.", betaDay(betaEnds()!))
          : "Market data is delayed by 15 minutes. Click to upgrade to live data.";

  return (
    <div class="tab-panel-actions">
      {/* Market data delay notice (the gateway serves 15-minute delayed data);
          with the paid tier (#252), the plan's state, which opens its dialog. */}
      <Show
        when={paidShown()}
        fallback={
          <Tooltip text="Market data is delayed by 15 minutes." side="bottom">
            <span class="data-delay-badge" data-qa-id="data-delay-badge">Delayed 15 min</span>
          </Tooltip>
        }
      >
        <Tooltip text={badgeTip()} side="bottom">
          <button
            type="button"
            class="data-delay-badge is-button"
            classList={{ "is-realtime": realtimeActive() }}
            data-qa-id="data-delay-badge"
            onClick={() => showPlanDialog()}
          >
            {realtimeActive()
              ? betaEnds() !== null ? "Live (beta)" : translateAs("Live", "market data")
              : realtimeElsewhere() ? "Live elsewhere" : "Delayed 15 min"}
          </button>
        </Tooltip>
      </Show>
      {/* Web version: where to get the desktop app (the desktop shows its window
          controls in this place). */}
      <Show when={WEB_BUILD}>
        <a
          class="get-desktop-app-button"
          data-qa-id="get-desktop-app-button"
          href={DESKTOP_DOWNLOAD_URL}
          target="_blank"
          rel="noopener"
          onClick={() => track("desktop_link_clicked")}
          // Middle click opens the link too.
          onAuxClick={(e) => { if (e.button === 1) track("desktop_link_clicked"); }}
        >
          Get the desktop app
        </a>
      </Show>
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
      {/* A downloaded update swaps the main-menu button for the reference app's green
          "Update the app" button; it opens the same menu. */}
      <Show
        when={updateReady()}
        fallback={
          <button
            type="button"
            class={"action-button main-menu-button" + (anchor() ? " opened" : "")}
            data-qa-id="main-menu-button"
            title="Main menu"
            aria-label="Main menu"
            aria-haspopup="menu"
            onClick={toggleMenu}
          >
            <Icon name="main-menu-meatballs" size={28} />
          </button>
        }
      >
        <button
          type="button"
          class={"main-menu-button main-menu-update-app-button" + (anchor() ? " opened" : "")}
          data-qa-id="main-menu-update-app-button"
          aria-haspopup="menu"
          onClick={toggleMenu}
        >
          <span class="main-menu-update-app-text">Update the app</span>
          <Icon name="main-menu-meatballs" size={28} />
        </button>
      </Show>
      <Show when={anchor()}>
        {(a) => (
          <MainMenu
            anchor={a()}
            onClose={() => setAnchor(null)}
            reopenLabel={props.reopenLabel}
            themeSetting={props.themeSetting}
            onThemeChange={props.onThemeChange}
            onOpenLink={props.onOpenLink}
            onAction={(action) => {
              if (action === "app-settings") props.onOpenAppSettings();
              else if (action === "new-tab") props.onNewTab();
              else props.onReopen();
            }}
          />
        )}
      </Show>
    </div>
  );
}
