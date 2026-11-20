/*
 * Saving an exported file (#369): chart data, screener and strategy reports,
 * logs, scripts, pictures. On the desktop, as the reference app: the file
 * goes into the downloads folder of Settings > General (the system one by
 * default) under a name of its own, or through the Save dialog when the user
 * asks for it each time or the folder is gone; then a "File downloaded" toast
 * (SavedFileToast) or an "Export failed" message. The browser download the
 * desktop used before saved without a word, so users could not tell where
 * the file went. The web version keeps the browser's download.
 */
import { createSignal } from "solid-js";
import { commands } from "../bindings";
import { showConfirm } from "../components/Dialogs";
import { settings, setSettings } from "../window/header/app-settings/store";
import { isTauri } from "../window/shell/window-bridge";

/** The last "File downloaded" toast: the folder of the file. */
const [savedFile, setSavedFile] = createSignal<{ id: number; folder: string } | null>(null);
export { savedFile };
export const hideSavedFile = () => setSavedFile(null);
let toastId = 0;

/** Folder of the last file saved through the Save dialog (this session): where the dialog opens next. */
let sessionFolder = "";
let systemFolder: Promise<string | null> | null = null;

/** The folder exports go into without asking (Settings > General > Downloads). */
export function downloadsFolder(): Promise<string | null> {
  if (settings.downloadFolder) return Promise.resolve(settings.downloadFolder);
  systemFolder ??= commands.downloadsDefaultFolder().catch(() => null);
  return systemFolder;
}

/** "C:\a\b.csv" → "C:\a". */
export function folderOf(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i > 0 ? path.slice(0, i) : path;
}

/** "text/csv" → "Text": the Save dialog's file type, as the reference names it. */
export function fileKind(type: string): string {
  const major = type.split("/")[0] || "file";
  return major.charAt(0).toUpperCase() + major.slice(1);
}

async function base64Of(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function browserDownload(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  // Some browsers read the blob after the click returns.
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Save `data` as the file `name` (`type`: its MIME type). */
export async function saveFile(name: string, data: string | Blob, type = "text/csv"): Promise<void> {
  if (!isTauri()) {
    browserDownload(name, typeof data === "string" ? new Blob([data], { type }) : data);
    return;
  }
  const ask = settings.downloadAsk;
  const folder = ask ? null : await downloadsFolder();
  const r = await commands.exportFileSave(
    name,
    typeof data === "string" ? data : await base64Of(data),
    typeof data !== "string",
    fileKind(typeof data === "string" ? type : data.type || type),
    folder,
    sessionFolder || (await downloadsFolder()),
  ).catch((e: unknown) => ({ status: "error" as const, error: String(e) }));
  if (r.status === "error") {
    console.error("[save-file]", name, r.error);
    showConfirm({ title: "Export failed", text: "File export was interrupted", mainText: "Ok", cancelText: null, intent: "neutral", onConfirm: () => {} });
    return;
  }
  // The user closed the Save dialog: nothing was asked to be saved.
  if (!r.data) return;
  const dir = folderOf(r.data);
  sessionFolder = dir;
  // Saving without asking into a folder that was gone went through the dialog: its folder is the new one.
  if (!ask && dir !== folder) setSettings("downloadFolder", dir);
  setSavedFile({ id: ++toastId, folder: dir });
}
