/*
 * ConsentCard — asks once whether the usage statistics may include the user's
 * IP address (data/analytics.ts). Shown while unanswered and statistics are
 * on; both answers can be changed later in Settings > Service > Privacy.
 */
import { Show } from "solid-js";
import { openUrl } from "@tauri-apps/plugin-opener";
import { PRIVACY_URL, setAnalyticsIpConsent, shouldAskIpConsent } from "../../data/analytics";
import { currentWindowLabel } from "./window-bridge";

export function ConsentCard() {
  const openPrivacy = (e: MouseEvent) => {
    e.preventDefault();
    void openUrl(PRIVACY_URL).catch(() => window.open(PRIVACY_URL, "_blank", "noopener"));
  };
  // The main window asks; detached windows don't repeat it.
  return (
    <Show when={currentWindowLabel() === "main" && shouldAskIpConsent()}>
      <div class="consent-card" role="dialog" aria-labelledby="consent-card-title" data-qa-id="consent-card">
        <div class="consent-card-title" id="consent-card-title">
          Help improve OpenTrader
        </div>
        <p class="consent-card-text">
          OpenTrader counts which features are used, with your city and country. May it also keep your IP
          address? No account, no symbols, nothing sold.{" "}
          <a href={PRIVACY_URL} onClick={openPrivacy}>
            Privacy
          </a>
        </p>
        <div class="consent-card-actions">
          <button type="button" class="consent-card-btn" onClick={() => setAnalyticsIpConsent(false)}>
            No thanks
          </button>
          <button type="button" class="consent-card-btn consent-card-btn--primary" onClick={() => setAnalyticsIpConsent(true)}>
            Allow
          </button>
        </div>
      </div>
    </Show>
  );
}
