/*
 * AppSettingsDialog — the desktop "App settings" modal. Solid port of the
 * reference mock's dialog: a left tab rail (General · Tabs · Video & Audio ·
 * Alerts · Service · Network · Coding agents · Plugins · Local data · About) + a page section; settings apply live
 * (no footer).
 *
 * Every control persists: alerts via alert-settings.ts, tab-title parts via
 * App (ot:tab-title-parts), the theme as an <html> class + ot:theme, and the
 * rest in one ot:app-settings blob (some of those have no consumer yet — each
 * is marked inert below). The **Tabs** tab edits the tab-title parts (order +
 * visibility) that the tab strip actually renders, controlled by App.
 *
 * One file per tab in ./app-settings; their backend calls are in app-settings/io.ts.
 */
import { createSignal, For } from "solid-js";
import { Icon } from "../../components/Icon";
import { Dialog } from "../../components/Dialog";
import type { TabTitlePartState } from "../shell/tab-title";
import type { ThemeSetting } from "../shell/app-theme";
import { isTauri } from "../shell/window-bridge";
import { AboutTab } from "./app-settings/AboutTab";
import { AgentsTab } from "./app-settings/AgentsTab";
import { AlertsTab } from "./app-settings/AlertsTab";
import { GeneralTab } from "./app-settings/GeneralTab";
import { LocalDataTab } from "./app-settings/LocalDataTab";
import { NetworkTab } from "./app-settings/NetworkTab";
import { PluginsTab } from "./app-settings/PluginsTab";
import { ServiceTab } from "./app-settings/ServiceTab";
import { TabsTab } from "./app-settings/TabsTab";

// Read by other parts of the app (crosshair relay, onboarding).
export { crosshairSyncSetting } from "./app-settings/store";
export { ThemePicker } from "./app-settings/GeneralTab";

export type AppSettingsTabId =
  | "general" | "tabs" | "alerts" | "service" | "network" | "agents" | "plugins" | "local-data" | "about";

type Props = {
  onClose: () => void;
  initialTab?: AppSettingsTabId;
  /** Tab-title parts (order + visibility) — controlled by App so the Tabs tab
   *  edits the same config the tab strip renders. */
  tabParts: TabTitlePartState[];
  onTabPartsChange: (parts: TabTitlePartState[]) => void;
  /** Theme picker: the theme setting, owned by App (app-theme.ts). */
  themeSetting: ThemeSetting;
  onThemeChange: (setting: ThemeSetting) => void;
};

const TABS: { id: AppSettingsTabId; label: string; icon: string }[] = [
  { id: "general", label: "General", icon: "settings-general" },
  { id: "tabs", label: "Tabs", icon: "settings-tabs" },
  { id: "alerts", label: "Alerts", icon: "settings-alerts" },
  { id: "service", label: "Service", icon: "settings-service" },
  // The desktop app's own connections (the browser has its own proxy settings).
  ...(isTauri() ? [{ id: "network" as const, label: "Network", icon: "settings-network" }] : []),
  // The local endpoint coding agents connect to (desktop app only).
  ...(isTauri() ? [{ id: "agents" as const, label: "Coding agents", icon: "settings-agents" }] : []),
  // Data and broker plugins on this computer (desktop app only: they connect to a local endpoint).
  ...(isTauri() ? [{ id: "plugins" as const, label: "Plugins", icon: "settings-plugins" }] : []),
  // Folders of CSV files kept in sync with the imported series (desktop app only: they need the disk).
  ...(isTauri() ? [{ id: "local-data" as const, label: "Local data", icon: "settings-local-data" }] : []),
  { id: "about", label: "About", icon: "settings-about" },
];

export function AppSettingsDialog(props: Props) {
  const [tab, setTab] = createSignal<AppSettingsTabId>(props.initialTab ?? "general");

  const body = () => {
    switch (tab()) {
      case "tabs": return <TabsTab parts={props.tabParts} onChange={props.onTabPartsChange} />;
      case "alerts": return <AlertsTab />;
      case "service": return <ServiceTab />;
      case "network": return <NetworkTab />;
      case "agents": return <AgentsTab />;
      case "plugins": return <PluginsTab />;
      case "local-data": return <LocalDataTab />;
      case "about": return <AboutTab />;
      default: return <GeneralTab themeSetting={props.themeSetting} onThemeChange={props.onThemeChange} />;
    }
  };

  return (
    <Dialog
      look="app-settings"
      layerClass="app-settings-backdrop"
      backdrop="close"
      class="app-settings-dialog"
      label="App settings"
      title="Settings"
      onClose={props.onClose}
      keys={{ target: "document" }}
    >
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
    </Dialog>
  );
}
