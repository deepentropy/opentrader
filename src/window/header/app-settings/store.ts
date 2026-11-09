/*
 * The app Settings values that have no store of their own, in one kv blob. Process singleton + createRoot
 * autosave, the alert-settings.ts pattern.
 */
import { createEffect, createRoot } from "solid-js";
import { createStore } from "solid-js/store";
import * as kv from "../../../data/kv";

const SETTINGS_KEY = "ot:app-settings";

type AppSettings = {
  /** "Sync crosshair across windows": the crosshair goes to every other
   *  window, no link colour needed (data/tab-link-bus.ts, default on). */
  crosshairSync: boolean;
};

const SETTINGS_DEFAULTS: AppSettings = {
  // ON by default.
  crosshairSync: true,
};

function loadSettings(): AppSettings {
  try {
    const raw = kv.getItem(SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        // Only the known fields (older blobs carry removed settings).
        const merged: AppSettings = { crosshairSync: typeof parsed.crosshairSync === "boolean" ? parsed.crosshairSync : SETTINGS_DEFAULTS.crosshairSync };
        // One-time migration (_v 2): older builds auto-persisted the blob
        // with crosshairSync:false while the checkbox was INERT — a stored
        // false predating the gate cannot be a deliberate choice, and it
        // would silently switch off linked-tab crosshair mirroring.
        if ((parsed as { _v?: number })._v === undefined) merged.crosshairSync = true;
        return merged;
      }
    }
  } catch {
    /* malformed — defaults */
  }
  return { ...SETTINGS_DEFAULTS };
}

export const [settings, setSettings] = createStore<AppSettings>(loadSettings());

createRoot(() => {
  createEffect(() => {
    try {
      // `_v` stamps the blob schema for one-time migrations (see loadSettings).
      kv.setItem(SETTINGS_KEY, JSON.stringify({ ...settings, _v: 2 }));
    } catch {
      /* best-effort */
    }
  });
});

// Live cross-window sync: re-load when another window changes the blob.
kv.onExternalChange(SETTINGS_KEY, () => setSettings(loadSettings()));

/** Reactive read of the "Sync crosshair across windows" switch — consumed by
 *  the cross-window crosshair relay in data/tab-link-bus.ts. */
export const crosshairSyncSetting = () => settings.crosshairSync;
