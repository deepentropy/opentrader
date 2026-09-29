/*
 * Alert settings — global preferences shared by the engine, the sound player,
 * and the Settings → Alerts tab. Mirrors TV's AlertSettingsProvider
 * (alertSoundEnabledChange / alertVolumeChange / alertNotificationEnabledChange).
 *
 * Process singleton + createRoot autosave, same pattern as the other stores.
 */
import { createRoot, createEffect } from "solid-js";
import { createStore } from "solid-js/store";
import * as kv from "./kv";

export type AlertSettings = {
  /** Play a sound when an alert fires. */
  soundEnabled: boolean;
  /** 0–100. */
  volume: number;
  /** Raise an OS/browser notification on fire (in addition to the in-app toast). */
  systemNotifications: boolean;
};

const KEY = "tv:alert-settings:v1";

const DEFAULTS: AlertSettings = {
  soundEnabled: true,
  volume: 60,
  systemNotifications: true,
};

function load(): AlertSettings {
  try {
    const raw = kv.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") return { ...DEFAULTS, ...parsed };
    }
  } catch {
    /* malformed — defaults */
  }
  return { ...DEFAULTS };
}

const [state, setState] = createStore<AlertSettings>(load());

createRoot(() => {
  createEffect(() => {
    try {
      kv.setItem(KEY, JSON.stringify({ ...state }));
    } catch {
      /* best-effort */
    }
  });
});

// Live cross-window sync: re-load when another window changes settings.
kv.onExternalChange(KEY, () => setState(load()));

export const alertSettings = {
  get: () => state,
  soundEnabled: () => state.soundEnabled,
  volume: () => state.volume,
  systemNotifications: () => state.systemNotifications,
  setSoundEnabled: (v: boolean) => setState("soundEnabled", v),
  setVolume: (v: number) => setState("volume", Math.max(0, Math.min(100, Math.round(v)))),
  setSystemNotifications: (v: boolean) => setState("systemNotifications", v),
};
