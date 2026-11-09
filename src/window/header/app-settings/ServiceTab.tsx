/*
 * Settings > Service: clear the cache, factory reset, usage statistics.
 */
import { createSignal, Show } from "solid-js";
import { CheckField } from "../../../components/form";
import { analyticsAvailable, analyticsEnabled, PRIVACY_URL, setAnalyticsEnabled } from "../../../data/analytics";
import { clearAppCache, factoryReset, openLink } from "./io";
import { ConfirmButton, Section } from "./parts";

export function ServiceTab() {
  const [cleared, setCleared] = createSignal(false);
  return (
    <>
      <Section label="APP DATA">
        <div class="app-settings-action-row">
          <span class="app-settings-action-label">App cache</span>
          <Show when={!cleared()} fallback={<button type="button" class="app-settings-btn" disabled>Cleared</button>}>
            <ConfirmButton
              label="Clear cache"
              confirmLabel="Confirm clear"
              onConfirm={() => {
                void clearAppCache().then((ok) => {
                  if (!ok) return;
                  setCleared(true);
                  window.setTimeout(() => setCleared(false), 1500);
                });
              }}
            />
          </Show>
        </div>
        <div class="app-settings-action-row">
          <span class="app-settings-action-label">Factory reset</span>
          <ConfirmButton label="Back to defaults" confirmLabel="Erase everything and restart" onConfirm={() => void factoryReset()} />
        </div>
      </Section>
      <Show when={analyticsAvailable()}>
        <Section label="PRIVACY">
          <CheckField variant="settings"
            label="Send usage statistics"
            checked={analyticsEnabled()}
            onChange={() => setAnalyticsEnabled(!analyticsEnabled())}
          />
          <div class="app-settings-note">
            Which features are used, with your IP address and city, to know what to improve. No account, no
            symbols.{" "}
            <a
              class="app-settings-about-link"
              href={PRIVACY_URL}
              onClick={(e) => {
                e.preventDefault();
                openLink(PRIVACY_URL, "privacy");
              }}
            >
              Privacy policy
            </a>
          </div>
        </Section>
      </Show>
    </>
  );
}
