/*
 * Web build stand-in for `@tauri-apps/plugin-opener` (aliased in
 * vite.config.ts): links open in a new browser tab.
 */
export async function openUrl(url: string | URL): Promise<void> {
  window.open(String(url), "_blank", "noopener");
}
