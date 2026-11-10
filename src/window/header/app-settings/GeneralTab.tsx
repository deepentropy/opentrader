/*
 * Settings > General: crosshair sync, theme, downloads folder.
 */
import { createSignal, For, onMount, Show } from "solid-js";
import { downloadDir } from "@tauri-apps/api/path";
import { CheckField } from "../../../components/form";
import type { ThemeSetting } from "../../shell/app-theme";
import { Section } from "./parts";
import { settings, setSettings } from "./store";

const THEME_OPTIONS: { id: ThemeSetting; label: string }[] = [
  { id: "system", label: "System" },
  { id: "dark", label: "Dark" },
  { id: "light", label: "Light" },
];

/** Thumbnail of the app in one theme: header, chart card with candles, right
 *  panel. `half` keeps the left (dark) or right (light) half for the System
 *  tile. */
function ThemeThumb(props: { theme: "dark" | "light"; half?: "left" | "right" }) {
  const c = () => (props.theme === "dark"
    ? { frame: "#2E2E2E", card: "#0F0F0F", line: "#3D3D3D" }
    : { frame: "#E0E3EB", card: "#FFFFFF", line: "#D1D4DC" });
  const aspect = () => (props.half === "left" ? "xMinYMid slice" : props.half === "right" ? "xMaxYMid slice" : "none");
  return (
    <svg viewBox="0 0 80 48" preserveAspectRatio={aspect()} aria-hidden="true">
      <rect width="80" height="48" fill={c().frame} />
      <rect x="4" y="9" width="54" height="39" rx="2" fill={c().card} />
      <rect x="61" y="9" width="19" height="39" rx="2" fill={c().card} />
      <rect x="64" y="14" width="12" height="2" rx="1" fill={c().line} />
      <rect x="64" y="20" width="12" height="2" rx="1" fill={c().line} />
      <rect x="64" y="26" width="12" height="2" rx="1" fill={c().line} />
      <rect x="12" y="24" width="4" height="10" fill="#22AB94" />
      <rect x="20" y="28" width="4" height="9" fill="#F23645" />
      <rect x="28" y="20" width="4" height="12" fill="#22AB94" />
      <rect x="36" y="17" width="4" height="8" fill="#22AB94" />
      <rect x="44" y="21" width="4" height="10" fill="#F23645" />
    </svg>
  );
}

/** System / Dark / Light tiles as in the reference desktop settings; `large`
 *  is the app onboarding's size. */
export function ThemePicker(props: { setting: ThemeSetting; onChange: (s: ThemeSetting) => void; large?: boolean }) {
  const apply = (s: ThemeSetting) => { if (s !== props.setting) props.onChange(s); };
  return (
    <div class={`app-settings-theme${props.large ? " large" : ""}`} role="radiogroup" aria-label="Theme">
      <For each={THEME_OPTIONS}>
        {(o) => (
          <button
            type="button"
            role="radio"
            aria-checked={props.setting === o.id}
            class={`app-settings-theme-option${props.setting === o.id ? " active" : ""}`}
            onClick={() => apply(o.id)}
          >
            <span class={`app-settings-theme-icon ${o.id}`}>
              <Show
                when={o.id === "system"}
                fallback={<ThemeThumb theme={o.id === "light" ? "light" : "dark"} />}
              >
                <span class="dark"><ThemeThumb theme="dark" half="left" /></span>
                <span class="light"><ThemeThumb theme="light" half="right" /></span>
              </Show>
              <Show when={props.setting === o.id}><span class="app-settings-theme-inner" /></Show>
            </span>
            <span class="app-settings-theme-label">{o.label}</span>
          </button>
        )}
      </For>
    </div>
  );
}

export function GeneralTab(props: { themeSetting: ThemeSetting; onThemeChange: (s: ThemeSetting) => void }) {
  const [downloadPath, setDownloadPath] = createSignal<string | null>(null);
  onMount(() => {
    if ("__TAURI_INTERNALS__" in window) void downloadDir().then(setDownloadPath).catch(() => setDownloadPath(null));
  });
  return (
    <>
      <Section label="CROSSHAIR">
        <CheckField variant="settings" label="Sync crosshair across windows" checked={settings.crosshairSync} onChange={() => setSettings("crosshairSync", !settings.crosshairSync)} />
      </Section>
      <Section label="THEME"><ThemePicker setting={props.themeSetting} onChange={props.onThemeChange} /></Section>
      <Section label="DOWNLOADS">
        <div class="app-settings-path-row">
          {/* Files are saved to the system download folder. */}
          <span class="app-settings-path" data-no-translate>{downloadPath() ?? ""}</span>
          {/* Needs an OS folder picker (Tauri dialog plugin) — not wired here. */}
          <button type="button" class="app-settings-btn" disabled title="Choosing a folder needs the OS file dialog, which isn't wired up yet"><span data-i18n-sense="action">Change</span></button>
        </div>
      </Section>
    </>
  );
}
