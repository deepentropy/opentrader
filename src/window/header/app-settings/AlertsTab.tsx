/*
 * Settings > Alerts: system notifications and the alert sound.
 */
import { CheckField } from "../../../components/form";
import { alertSettings } from "../../../data/alert-settings";
import { Section } from "./parts";

export function AlertsTab() {
  // Persisted via alert-settings.ts; read reactively through the store.
  return (
    <>
      <Section label="NOTIFICATIONS">
        <CheckField variant="settings"
          label="Use system notifications for alerts"
          checked={alertSettings.systemNotifications()}
          onChange={() => alertSettings.setSystemNotifications(!alertSettings.systemNotifications())}
        />
      </Section>
      <Section label="SOUND">
        <CheckField variant="settings"
          label="Play a sound when an alert fires"
          checked={alertSettings.soundEnabled()}
          onChange={() => alertSettings.setSoundEnabled(!alertSettings.soundEnabled())}
        />
        <input
          type="range"
          class="app-settings-slider"
          min={0}
          max={100}
          value={alertSettings.volume()}
          onInput={(e) => alertSettings.setVolume(Number(e.currentTarget.value))}
          aria-label="Alert volume"
        />
      </Section>
    </>
  );
}
