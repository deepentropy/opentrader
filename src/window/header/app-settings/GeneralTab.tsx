/*
 * Settings > General: crosshair sync, theme, downloads (folder, ask each time).
 */
import { createEffect, createSignal, For, Show } from "solid-js";
import { commands } from "../../../bindings";
import { downloadsFolder } from "../../../data/save-file";
import { isTauri } from "../../shell/window-bridge";
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
 *  is the app onboarding's size, `compact` the title bar main menu's. */
export function ThemePicker(props: { setting: ThemeSetting; onChange: (s: ThemeSetting) => void; large?: boolean; compact?: boolean }) {
  const apply = (s: ThemeSetting) => { if (s !== props.setting) props.onChange(s); };
  return (
    <div class={`app-settings-theme${props.large ? " large" : props.compact ? " compact" : ""}`} role="radiogroup" aria-label="Theme">
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
  // The folder exports are saved into (#369, data/save-file.ts); the browser decides in the web version.
  const [downloadPath, setDownloadPath] = createSignal("");
  createEffect(() => {
    void settings.downloadFolder;
    if (isTauri()) void downloadsFolder().then((p) => setDownloadPath(p ?? ""));
  });
  const changeFolder = async () => {
    const r = await commands.downloadsFolderPick(downloadPath() || null);
    if (r.status === "ok" && r.data) setSettings("downloadFolder", r.data);
  };
  return (
    <>
      <Section label="CROSSHAIR">
        <CheckField variant="settings" label="Sync crosshair across windows" checked={settings.crosshairSync} onChange={() => setSettings("crosshairSync", !settings.crosshairSync)} />
      </Section>
      <Section label="THEME"><ThemePicker setting={props.themeSetting} onChange={props.onThemeChange} /></Section>
      <Show when={isTauri()}>
        <Section label="DOWNLOADS">
          <div class="app-settings-path-row">
            {/* Opens the folder; inactive while every file asks where to go. */}
            <span
              class={`app-settings-path${settings.downloadAsk ? " disabled" : ""}`}
              role="link"
              tabIndex={settings.downloadAsk ? -1 : 0}
              data-no-translate
              data-name="downloads-folder"
              onClick={() => { if (!settings.downloadAsk && downloadPath()) void commands.openFolder(downloadPath()); }}
            >
              {downloadPath()}
            </span>
            <button type="button" class="app-settings-btn" data-name="downloads-change" disabled={settings.downloadAsk} onClick={() => void changeFolder()}>
              <span data-i18n-sense="action">Change</span>
            </button>
          </div>
          <CheckField variant="settings" label="Always ask where to save files" checked={settings.downloadAsk} onChange={() => setSettings("downloadAsk", !settings.downloadAsk)} />
        </Section>
      </Show>
    </>
  );
}
