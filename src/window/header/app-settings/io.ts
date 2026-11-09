/*
 * What the Settings tabs ask of the app's backend and the system: each call returns what its tab shows and
 * logs what it does not.
 */
import { openUrl } from "@tauri-apps/plugin-opener";
import { commands, type AgentServerStatus, type ProxySettings } from "../../../bindings";

/** Opens a link in the system browser. */
export function openLink(url: string, what: string): void {
  void openUrl(url).catch((e) => console.warn(`[settings] open ${what} failed`, e));
}

/** Empties the market-data disk cache and the in-memory series (bars are fetched again on the next load);
 *  true when done. */
export async function clearAppCache(): Promise<boolean> {
  const r = await commands.clearCache();
  if (r.status === "error") console.warn("[settings] clear cache failed", r.error);
  return r.status === "ok";
}

/** Wipe ALL durable state: the kv store file + localStorage, then reload. kv exposes no enumeration, so the store is cleared
 *  through the plugin directly; `load` is by-path shared with kv's own handle
 *  (see kv.ts STORE_FILE), so clearing it also stops kv's later autosaves from
 *  resurrecting old keys. */
export async function factoryReset(): Promise<void> {
  if ("__TAURI_INTERNALS__" in window) {
    try {
      // The proxy and its password in the system's credential store.
      await commands.resetProxySettings();
    } catch {
      /* the rest of the reset still runs */
    }
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

export const loadProxySettings = (): Promise<ProxySettings> => commands.getProxySettings();

/** Applies the proxy; `notStored` when its password could not go to the system's credential store (it then
 *  lasts until the app closes). */
export async function saveProxySettings(p: ProxySettings): Promise<{ notStored: boolean }> {
  const r = await commands.setProxySettings(p);
  if (r.status === "error") console.warn("[settings] proxy", r.error);
  return { notStored: r.status === "error" && r.error.startsWith("credential store") };
}

export type AgentServerResult = { status: "ok"; data: AgentServerStatus } | { status: "error"; error: string };

/** The local endpoint coding agents connect to. */
export const agentServer = {
  status: (): Promise<AgentServerStatus> => commands.agentServerStatus(),
  setEnabled: (on: boolean): Promise<AgentServerResult> => commands.agentServerSetEnabled(on),
  setPort: (port: number): Promise<AgentServerResult> => commands.agentServerSetPort(port),
  newToken: (): Promise<AgentServerResult> => commands.agentServerNewToken(),
};

/** The system folder picker: the folder, null when cancelled, or the error. */
export async function pickFolder(): Promise<{ path: string | null } | { error: string }> {
  const r = await commands.localFolderPick();
  return r.status === "error" ? { error: r.error } : { path: r.data };
}
