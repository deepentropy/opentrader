/*
 * App update state for the UI (the Rust side is src-tauri/src/app_update.rs):
 * the title-bar "Update the app" button, the main-menu "Relaunch to update"
 * row and the Settings > About block. The reference app design + rules:
 * .tmp/app-update/doc.
 */
import { createSignal } from "solid-js";
import { commands, events, type AppUpdateStatus, type BuildInfo } from "../bindings";
import { flushKv } from "./kv";

const [status, setStatus] = createSignal<AppUpdateStatus>({ state: "up-to-date", version: null });

/** Current update state (same in every window). */
export const appUpdateStatus = status;

/** True once the new version is downloaded and can be installed. */
export const updateReady = () => status().state === "ready-to-install";

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

let started = false;

/** Follow the update state and answer the pre-install settings flush. Every
 *  window calls it once at boot. */
export function initAppUpdate(): void {
  if (started || !isTauri()) return;
  started = true;
  void events.appUpdateStatus.listen((e) => setStatus(e.payload));
  void commands.appUpdateStatus().then(setStatus);
  // Before the installer runs: write this window's pending settings, then confirm.
  void events.appUpdateBeforeInstall.listen(() => {
    void flushKv().finally(() => void commands.appUpdateFlushed());
  });
}

/** Check now (Settings > About opened, like the reference app). */
export function checkForUpdates(): void {
  if (isTauri()) void commands.appUpdateCheck();
}

/** "Relaunch to update": save, install, restart. */
export function installUpdate(): void {
  if (!isTauri()) return;
  void commands.appUpdateInstall().then((r) => {
    if (r.status === "error") console.error("[app-update] install failed", r.error);
  });
}

/** App version and build date (Settings > About). */
export function buildInfo(): Promise<BuildInfo | null> {
  return isTauri() ? commands.appBuildInfo() : Promise.resolve(null);
}
