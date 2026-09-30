/*
 * AppSettingsDialog — the desktop "App settings" modal. Solid port of the
 * reference mock's dialog: a left tab rail (General · Tabs · Video & Audio ·
 * Alerts · Service · Network · About) + a page section; settings apply live
 * (no footer).
 *
 * Every control persists: alerts via alert-settings.ts, tab-title parts via
 * App (ot:tab-title-parts), the theme as an <html> class + ot:theme, and the
 * rest in one ot:app-settings blob (some of those have no consumer yet — each
 * is marked inert below). The **Tabs** tab edits the tab-title parts (order +
 * visibility) that the tab strip actually renders, controlled by App.
 */
import { createEffect, createRoot, createSignal, For, Show, onCleanup, onMount, type JSX } from "solid-js";
import { createStore } from "solid-js/store";
import { Portal } from "solid-js/web";
import { Icon } from "../../components/Icon";
import {
  DEFAULT_TAB_TITLE_PARTS,
  TAB_TITLE_LABEL,
  type TabTitlePartState,
} from "../shell/tab-title";
import { alertSettings } from "../../data/alert-settings";
import * as kv from "../../data/kv";
import { fundingStatus, type Funding } from "../../data/funding";
import { appUpdateStatus, buildInfo, checkForUpdates, installUpdate } from "../../data/app-update";
import type { BuildInfo } from "../../bindings";
import { openUrl } from "@tauri-apps/plugin-opener";

// ── Persisted dialog settings ────────────────────────────────────────────────
// One kv blob for every control here that has no dedicated store. Process
// singleton + createRoot autosave, the alert-settings.ts pattern.
const SETTINGS_KEY = "ot:app-settings";

type AppSettings = {
  autofillCredentials: boolean; // inert: no broker plumbing
  /** "Sync crosshair across windows": the crosshair goes to every other
   *  window, no link colour needed (data/tab-link-bus.ts, default on). */
  crosshairSync: boolean;
  askDownloadPath: boolean; // inert: downloads not wired
  camera: string; // inert: no media capture
  microphone: string; // inert: no media capture
  autoRestoreTabs: boolean; // inert: tabs.ts always restores
  disableHwAccel: boolean; // inert: needs a src-tauri startup flag to honour it
  proxyEnabled: boolean; // inert (whole proxy group): no request layer reads it
  proxyProtocol: string;
  proxyHost: string;
  proxyPort: string;
  proxyUsername: string;
  proxyPassword: string;
};

const SETTINGS_DEFAULTS: AppSettings = {
  autofillCredentials: false,
  // ON by default.
  crosshairSync: true,
  askDownloadPath: false,
  camera: "Default",
  microphone: "Default",
  autoRestoreTabs: true,
  disableHwAccel: false,
  proxyEnabled: false,
  proxyProtocol: "HTTP",
  proxyHost: "",
  proxyPort: "",
  proxyUsername: "",
  proxyPassword: "",
};

function loadSettings(): AppSettings {
  try {
    const raw = kv.getItem(SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        const merged = { ...SETTINGS_DEFAULTS, ...parsed };
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

const [settings, setSettings] = createStore<AppSettings>(loadSettings());

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

export type AppSettingsTabId =
  | "general" | "tabs" | "video" | "alerts" | "service" | "network" | "about";

type Props = {
  onClose: () => void;
  initialTab?: AppSettingsTabId;
  /** Tab-title parts (order + visibility) — controlled by App so the Tabs tab
   *  edits the same config the tab strip renders. */
  tabParts: TabTitlePartState[];
  onTabPartsChange: (parts: TabTitlePartState[]) => void;
};

const TABS: { id: AppSettingsTabId; label: string; icon: string }[] = [
  { id: "general", label: "General", icon: "settings-general" },
  { id: "tabs", label: "Tabs", icon: "settings-tabs" },
  { id: "video", label: "Video & Audio", icon: "settings-video" },
  { id: "alerts", label: "Alerts", icon: "settings-alerts" },
  { id: "service", label: "Service", icon: "settings-service" },
  { id: "network", label: "Network", icon: "settings-network" },
  { id: "about", label: "About", icon: "settings-about" },
];

const Check = () => (
  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
    <path fill="none" stroke="currentColor" stroke-width="2" d="m3.5 8 3 3 6-6.5" />
  </svg>
);

function Section(props: { label: string; children: JSX.Element }) {
  return (
    <section class="app-settings-section">
      <label class="app-settings-section-label">{props.label}</label>
      <div class="app-settings-section-content">{props.children}</div>
    </section>
  );
}

function Checkbox(props: { label: string; checked: boolean; onChange: () => void }) {
  return (
    <label class="app-settings-check">
      <input type="checkbox" checked={props.checked} onChange={props.onChange} />
      <span class={`app-settings-checkbox${props.checked ? " is-checked" : ""}`}>
        <Show when={props.checked}><Check /></Show>
      </span>
      <span class="app-settings-check-label">{props.label}</span>
    </label>
  );
}

function Select(props: { value: string; options: string[]; onChange: (v: string) => void }) {
  return (
    <select class="app-settings-select" value={props.value} onChange={(e) => props.onChange(e.currentTarget.value)}>
      <For each={props.options}>{(o) => <option value={o}>{o}</option>}</For>
    </select>
  );
}

/** Theme is applied as the <html> class the stylesheets key on (tokens.css:
 *  html.theme-dark / html.theme-light) and persisted under ot:theme. App's
 *  chart-canvas `theme` signal (App.tsx) is still a fixed "dark" — it has to
 *  seed from this key for the lightweight-charts canvases to follow. */
const THEME_KEY = "ot:theme";

function ThemePicker() {
  const current = () => (document.documentElement.classList.contains("theme-light") ? "light" : "dark");
  const [theme, setTheme] = createSignal<"dark" | "light">(current());
  const apply = (t: "dark" | "light") => {
    setTheme(t);
    document.documentElement.classList.remove("theme-dark", "theme-light");
    document.documentElement.classList.add(`theme-${t}`);
    kv.setItem(THEME_KEY, t);
  };
  return (
    <div class="app-settings-theme">
      <For each={["light", "dark"] as const}>
        {(t) => (
          <button
            type="button"
            class={`app-settings-theme-pill${theme() === t ? " selected" : ""}`}
            onClick={() => apply(t)}
          >
            {t === "light" ? "Light" : "Dark"}
          </button>
        )}
      </For>
    </div>
  );
}

function GeneralTab() {
  return (
    <>
      <Section label="CREDENTIALS AND CROSSHAIR">
        <Checkbox label="Auto-fill broker credentials" checked={settings.autofillCredentials} onChange={() => setSettings("autofillCredentials", !settings.autofillCredentials)} />
        <Checkbox label="Sync crosshair across windows" checked={settings.crosshairSync} onChange={() => setSettings("crosshairSync", !settings.crosshairSync)} />
      </Section>
      <Section label="THEME"><ThemePicker /></Section>
      <Section label="DOWNLOADS">
        <div class="app-settings-path-row">
          <a class={`app-settings-path${settings.askDownloadPath ? " disabled" : ""}`}>C:\\Users\\trader\\Downloads</a>
          {/* Needs an OS folder picker (Tauri dialog plugin) — not wired here. */}
          <button type="button" class="app-settings-btn" disabled title="Choosing a folder needs the OS file dialog, which isn't wired up yet">Change</button>
        </div>
        <Checkbox label="Always ask where to save files" checked={settings.askDownloadPath} onChange={() => setSettings("askDownloadPath", !settings.askDownloadPath)} />
      </Section>
    </>
  );
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

function TabsTab(props: { parts: TabTitlePartState[]; onChange: (p: TabTitlePartState[]) => void }) {
  // Sliding drag-reorder: the order array stays put during the drag — only
  // transforms move. The grabbed row follows the cursor; rows it passes slide
  // one slot to open the landing gap. On pointer-up we reorder + clear.
  const [drag, setDrag] = createSignal<{ id: string; from: number; dy: number; stride: number } | null>(null);
  let info: { id: string; from: number; stride: number; startY: number } | null = null;
  let listEl: HTMLDivElement | undefined;

  const toggle = (id: string) =>
    props.onChange(props.parts.map((p) => (p.id === id ? { ...p, visible: !p.visible } : p)));
  const reset = () => props.onChange(DEFAULT_TAB_TITLE_PARTS.map((p) => ({ ...p })));

  const targetIndex = (d: { from: number; dy: number; stride: number }) =>
    clamp(d.from + Math.round(d.dy / d.stride), 0, props.parts.length - 1);

  const onHandleDown = (e: PointerEvent, id: string, index: number) => {
    e.preventDefault();
    const rows = listEl?.querySelectorAll<HTMLElement>(".app-settings-drag-row");
    const stride = rows && rows.length > 1
      ? rows[1].getBoundingClientRect().top - rows[0].getBoundingClientRect().top
      : 36;
    info = { id, from: index, stride, startY: e.clientY };
    setDrag({ id, from: index, dy: 0, stride });
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };
  const onHandleMove = (e: PointerEvent) => {
    if (!info) return;
    setDrag({ id: info.id, from: info.from, stride: info.stride, dy: e.clientY - info.startY });
  };
  const onHandleUp = (e: PointerEvent) => {
    const i = info;
    info = null;
    try { (e.currentTarget as Element).releasePointerCapture(e.pointerId); } catch { /* released */ }
    if (i) {
      const to = targetIndex({ from: i.from, dy: e.clientY - i.startY, stride: i.stride });
      if (to !== i.from) {
        const next = props.parts.slice();
        const [moved] = next.splice(i.from, 1);
        next.splice(to, 0, moved);
        props.onChange(next);
      }
    }
    setDrag(null);
  };

  const rowStyle = (i: number): JSX.CSSProperties => {
    const d = drag();
    if (!d) return {};
    if (props.parts[i].id === d.id) {
      return { transform: `translateY(${d.dy}px)`, transition: "none", "z-index": 2, position: "relative" };
    }
    const to = targetIndex(d);
    let ty = 0;
    if (to > d.from && i > d.from && i <= to) ty = -d.stride;
    else if (to < d.from && i >= to && i < d.from) ty = d.stride;
    return { transform: `translateY(${ty}px)`, transition: "transform 0.15s ease" };
  };

  return (
    <>
      <Section label="ON STARTUP">
        <Checkbox label="Auto-restore tickers and intervals" checked={settings.autoRestoreTabs} onChange={() => setSettings("autoRestoreTabs", !settings.autoRestoreTabs)} />
      </Section>
      <Section label="TAB TITLE (DRAG TO REORDER)">
        <div class="app-settings-tab-order" ref={listEl}>
          <For each={props.parts}>
            {(p, i) => (
              <div
                class={`app-settings-drag-row${drag()?.id === p.id ? " is-dragging" : ""}`}
                style={rowStyle(i())}
              >
                <Checkbox label={TAB_TITLE_LABEL[p.id]} checked={p.visible} onChange={() => toggle(p.id)} />
                <span
                  class="app-settings-drag-handle"
                  aria-label="Drag to reorder"
                  onPointerDown={(e) => onHandleDown(e, p.id, i())}
                  onPointerMove={onHandleMove}
                  onPointerUp={onHandleUp}
                >
                  <Icon name="settings-drag" size={18} />
                </span>
              </div>
            )}
          </For>
        </div>
      </Section>
      <div class="app-settings-control-button">
        <button type="button" class="app-settings-btn" onClick={reset}>Back to defaults</button>
      </div>
    </>
  );
}

function VideoAudioTab() {
  return (
    <>
      <Section label="VIDEO">
        <div class="app-settings-field">
          <label class="app-settings-field-label">Camera</label>
          <Select value={settings.camera} options={["Default", "No camera"]} onChange={(v) => setSettings("camera", v)} />
        </div>
      </Section>
      <Section label="AUDIO">
        <div class="app-settings-field">
          <label class="app-settings-field-label">Microphone</label>
          <Select value={settings.microphone} options={["Default", "No microphone"]} onChange={(v) => setSettings("microphone", v)} />
        </div>
      </Section>
    </>
  );
}

function AlertsTab() {
  // Persisted via alert-settings.ts; read reactively through the store.
  return (
    <>
      <Section label="NOTIFICATIONS">
        <Checkbox
          label="Use system notifications for alerts"
          checked={alertSettings.systemNotifications()}
          onChange={() => alertSettings.setSystemNotifications(!alertSettings.systemNotifications())}
        />
      </Section>
      <Section label="SOUND">
        <Checkbox
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

// kv keys that are transient / re-derivable — dropped by "Clear cache". Layout
// (ot:layouts, ot:layout-autosave), drawings (ot:drawings:*, ot:drawing-templates,
// ot:drawing-kind-defaults) and every settings blob are deliberately NOT listed.
// NOT caches (audit 12/07): ot:drawing-sync is the drawing sync-scope
// preference and ot:layout-sync the per-layout sync toggles; ot:tab-link is a
// BroadcastChannel name, never a kv key.
const CACHE_KEYS = [
  "ot:symbol-search:type-filter", // last symbol-search Type chip
];

/** Two-click confirm: the first click arms the button (label swaps to
 *  `confirmLabel`) and a timeout disarms it; the second click runs `action`. */
function ConfirmButton(props: { label: string; confirmLabel: string; onConfirm: () => void }) {
  const [armed, setArmed] = createSignal(false);
  let timer: number | undefined;
  onCleanup(() => window.clearTimeout(timer));
  return (
    <button
      type="button"
      class={`app-settings-btn${armed() ? " is-armed" : ""}`}
      onClick={() => {
        if (!armed()) {
          setArmed(true);
          timer = window.setTimeout(() => setArmed(false), 4000);
          return;
        }
        window.clearTimeout(timer);
        setArmed(false);
        props.onConfirm();
      }}
    >
      {armed() ? props.confirmLabel : props.label}
    </button>
  );
}

/** Wipe ALL durable state: the kv store file + localStorage, then reload. kv exposes no enumeration, so the store is cleared
 *  through the plugin directly; `load` is by-path shared with kv's own handle
 *  (see kv.ts STORE_FILE), so clearing it also stops kv's later autosaves from
 *  resurrecting old keys. */
async function factoryReset(): Promise<void> {
  if ("__TAURI_INTERNALS__" in window) {
    try {
      const { load } = await import("@tauri-apps/plugin-store");
      const store = await load("opentrader.json");
      await store.clear();
      await store.save();
    } catch {
      /* store unavailable — the rest of the reset still runs */
    }
  }
  try {
    localStorage.clear();
  } catch {
    /* unavailable */
  }
  location.reload();
}

function ServiceTab() {
  const [cleared, setCleared] = createSignal(false);
  return (
    <>
      <Section label="PERFORMANCE">
        <Checkbox label="Disable hardware acceleration" checked={settings.disableHwAccel} onChange={() => setSettings("disableHwAccel", !settings.disableHwAccel)} />
      </Section>
      <Section label="APP DATA">
        <div class="app-settings-action-row">
          <span class="app-settings-action-label">App cache</span>
          <Show when={!cleared()} fallback={<button type="button" class="app-settings-btn" disabled>Cleared</button>}>
            <ConfirmButton
              label="Clear cache"
              confirmLabel="Confirm clear"
              onConfirm={() => {
                for (const k of CACHE_KEYS) kv.removeItem(k);
                setCleared(true);
                window.setTimeout(() => setCleared(false), 1500);
              }}
            />
          </Show>
        </div>
        <div class="app-settings-action-row">
          <span class="app-settings-action-label">Factory reset</span>
          <ConfirmButton label="Back to defaults" confirmLabel="Erase everything and restart" onConfirm={() => void factoryReset()} />
        </div>
      </Section>
    </>
  );
}

function NetworkTab() {
  const fields = [
    ["Server IP address or domain name*", "text", "proxyHost"],
    ["Port*", "text", "proxyPort"],
    ["Username", "text", "proxyUsername"],
    ["Password", "password", "proxyPassword"],
  ] as const;
  return (
    <>
      <Section label="PROXY SETTINGS">
        <Checkbox label="Use a proxy server" checked={settings.proxyEnabled} onChange={() => setSettings("proxyEnabled", !settings.proxyEnabled)} />
      </Section>
      <Section label="Proxy protocol">
        <Select value={settings.proxyProtocol} options={["HTTP", "HTTPS", "SOCKS4", "SOCKS5"]} onChange={(v) => setSettings("proxyProtocol", v)} />
      </Section>
      <For each={fields}>
        {([label, type, key]) => (
          <div class="app-settings-field">
            <label class="app-settings-field-label">{label}</label>
            <input
              class="app-settings-input"
              type={type}
              disabled={!settings.proxyEnabled}
              value={settings[key]}
              onInput={(e) => setSettings(key, e.currentTarget.value)}
            />
          </div>
        )}
      </For>
    </>
  );
}

function AboutTab() {
  const [info, setInfo] = createSignal<BuildInfo | null>(null);
  onMount(() => {
    void buildInfo().then(setInfo);
    // TV checks for an update each time About opens.
    checkForUpdates();
  });
  /** "2026-09-30" → "30/09/2026". */
  const date = (iso: string) => iso.split("-").reverse().join("/");
  return (
    <div class="app-settings-about">
      <div class="app-settings-about-app">OpenTrader</div>
      <Show when={info()}>
        {(i) => <div class="app-settings-about-version">{`Version ${i().version} · ${date(i().buildDate)}`}</div>}
      </Show>
      {/* TV hides its update block on Linux (no in-app update there). */}
      <Show when={!/Linux/.test(navigator.userAgent)}>
        <UpdateAppBlock />
      </Show>
      <div class="app-settings-about-copyright">Copyright © 2026 OpenTrader</div>
      <FundingBlock />
    </div>
  );
}

/** TV's About update status block (`update-app`): one row per update state,
 *  "Relaunch" once the new version is downloaded. Error shows as up to date,
 *  like TV. */
function UpdateAppBlock() {
  const state = () => appUpdateStatus().state;
  const view = (): { text: string; icon: JSX.Element } => {
    switch (state()) {
      case "checking":
        return { text: "Checking for updates", icon: <UpdateSpinner /> };
      case "downloading":
        return { text: "New version is downloading", icon: <Icon name="update-app-download" size={28} /> };
      case "ready-to-install":
        return { text: "Relaunch to update the app", icon: <Icon name="update-app-check" size={28}/> };
      case "installing":
        return { text: "Relaunching the app to install new version", icon: <Icon name="update-app-check" size={28}/> };
      default:
        return { text: "OpenTrader is up to date", icon: <Icon name="update-app-check" size={28}/> };
    }
  };
  return (
    <div class={`update-app ${state()}`}>
      <div class="update-app-text-container">
        <div class="update-app-status-icon">{view().icon}</div>
        <span class="update-app-status-text">{view().text}</span>
      </div>
      <Show when={state() === "installing"}>
        <UpdateSpinner />
      </Show>
      <Show when={state() === "ready-to-install"}>
        <button type="button" class="update-app-relaunch" onClick={installUpdate}>
          Relaunch
        </button>
      </Show>
    </div>
  );
}

/** TV ui-lib progress spinner, size small (24px), intent neutral. */
function UpdateSpinner() {
  return (
    <svg class="update-app-spinner" width="24" height="24" viewBox="0 0 24 24" role="progressbar" aria-label="Loading">
      <circle class="update-app-spinner-bg" cx="12" cy="12" r="11" />
      <circle class="update-app-spinner-fg" cx="12" cy="12" r="11" />
    </svg>
  );
}

/** This month's running cost and how much donations cover (data/funding.ts).
 *  Hidden while loading and when the gateway has no status. */
function FundingBlock() {
  const [status, setStatus] = createSignal<Funding | null>(null);
  onMount(() => void fundingStatus().then(setStatus));
  const money = (n: number, currency: string) => `${Math.round(n)} ${currency}`;
  const monthName = (m: string) =>
    new Date(`${m}-01T00:00:00Z`).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  const open = (url: string) => void openUrl(url).catch((e) => console.warn("[funding] open link failed", e));
  return (
    <Show when={status()}>
      {(s) => (
        <div class="app-settings-funding">
          <div class="app-settings-funding-title">Support OpenTrader</div>
          <div class="app-settings-funding-text">
            OpenTrader is free. Market data, servers and development tools cost{" "}
            {money(s().total, s().currency)} in {monthName(s().month)}.
          </div>
          <div class="app-settings-funding-bar">
            <div
              class="app-settings-funding-fill"
              style={{ width: `${s().total > 0 ? Math.min(100, (s().raised / s().total) * 100) : 100}%` }}
            />
          </div>
          <div class="app-settings-funding-numbers">
            <span>{money(s().raised, s().currency)} covered</span>
            <span>
              {s().remaining > 0 ? `${money(s().remaining, s().currency)} left to cover` : "Covered, thank you"}
            </span>
          </div>
          <div class="app-settings-funding-links">
            <Show when={s().links.github}>
              <button type="button" class="app-settings-btn" onClick={() => open(s().links.github)}>
                Sponsor on GitHub
              </button>
            </Show>
            <Show when={s().links.bmc}>
              <button type="button" class="app-settings-btn" onClick={() => open(s().links.bmc)}>
                Buy Me a Coffee
              </button>
            </Show>
          </div>
        </div>
      )}
    </Show>
  );
}

export function AppSettingsDialog(props: Props) {
  const [tab, setTab] = createSignal<AppSettingsTabId>(props.initialTab ?? "general");

  onMount(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); props.onClose(); } };
    document.addEventListener("keydown", onKey, true);
    onCleanup(() => document.removeEventListener("keydown", onKey, true));
  });

  const body = () => {
    switch (tab()) {
      case "tabs": return <TabsTab parts={props.tabParts} onChange={props.onTabPartsChange} />;
      case "video": return <VideoAudioTab />;
      case "alerts": return <AlertsTab />;
      case "service": return <ServiceTab />;
      case "network": return <NetworkTab />;
      case "about": return <AboutTab />;
      default: return <GeneralTab />;
    }
  };

  return (
    <Portal mount={document.body}>
      <div class="app-settings-backdrop" onMouseDown={() => props.onClose()}>
        <div class="app-settings-dialog" role="dialog" aria-label="App settings" onMouseDown={(e) => e.stopPropagation()}>
          <div class="app-settings-header">
            <span class="app-settings-dialog-title">Settings</span>
            <button type="button" class="app-settings-close" aria-label="Close" onClick={() => props.onClose()}>
              <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
                <path fill="none" stroke="currentColor" stroke-width="1.5" d="m3 3 10 10M13 3 3 13" />
              </svg>
            </button>
          </div>
          <div class="app-settings-body">
            <nav class="app-settings-tabs" aria-label="Settings categories">
              <For each={TABS}>
                {(t) => (
                  <button
                    type="button"
                    class={`app-settings-tab${tab() === t.id ? " selected" : ""}`}
                    aria-selected={tab() === t.id}
                    onClick={() => setTab(t.id)}
                  >
                    <Icon name={t.icon} size={24} />
                    <span>{t.label}</span>
                  </button>
                )}
              </For>
            </nav>
            <div class="app-settings-page">{body()}</div>
          </div>
        </div>
      </div>
    </Portal>
  );
}
