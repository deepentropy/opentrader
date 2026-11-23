/*
 * The AI assistant's model, on this computer (src-tauri/src/local_model.rs): what it needs, its download and its
 * removal.
 */
import { Channel } from "@tauri-apps/api/core";
import { createSignal } from "solid-js";
import { commands, type LocalModelInfo, type LocalProgress } from "../../bindings";
import { trackModelDownload } from "./telemetry";

const [info, setInfo] = createSignal<LocalModelInfo | null>(null);
const [progress, setProgress] = createSignal<LocalProgress | null>(null);
const [error, setError] = createSignal<string | null>(null);
export { info as localInfo, progress as localProgress, error as localError };

export async function refreshLocal(): Promise<void> {
  const r = await commands.localModelInfo();
  if (r.status === "ok") setInfo(r.data);
}

/** What keeps the model from running here, or null. */
export type LocalBlocker = "unavailable" | "low_memory" | "low_disk";

export function localBlockerKind(i: LocalModelInfo): LocalBlocker | null {
  const [ram, need, free, down] = [i.ramBytes ?? 0, i.ramNeededBytes ?? 0, i.freeDiskBytes ?? 0, i.downloadBytes ?? 0];
  if (!i.available) return "unavailable";
  if (ram && ram < need) return "low_memory";
  if (!i.installed && free && free < down * 1.1) return "low_disk";
  return null;
}

/** Where the model stands, for the usage statistics: ready, not activated yet, or what keeps it from running here. */
export function localState(i: LocalModelInfo | null): string {
  if (!i) return "unknown";
  if (i.installed) return "ready";
  return localBlockerKind(i) ?? "not_activated";
}

/** Why the model can't run here, or null: too little memory or disk space. */
export function localBlocker(i: LocalModelInfo): string | null {
  const [ram, need, free, down] = [i.ramBytes ?? 0, i.ramNeededBytes ?? 0, i.freeDiskBytes ?? 0, i.downloadBytes ?? 0];
  switch (localBlockerKind(i)) {
    case "unavailable": return "No model for this system in this version.";
    case "low_memory": return `It needs ${gb(need)} of memory; this computer has ${gb(ram)}.`;
    case "low_disk": return `It needs ${gb(down)} of free disk space (${gb(free)} free).`;
    default: return null;
  }
}

/** Bytes as GB, one decimal under 10 GB (byte counts come as numbers or null from Rust). */
export const gb = (bytes: number | null) => {
  const b = bytes ?? 0;
  return `${(b / 1024 ** 3).toFixed(b < 10 * 1024 ** 3 ? 1 : 0)} GB`;
};

export async function installLocal(): Promise<void> {
  setError(null);
  const update = !!info()?.installed;
  const started = Date.now();
  const ch = new Channel<LocalProgress>();
  ch.onmessage = (p) => setProgress(p);
  const r = await commands.localModelInstall(ch);
  setProgress(null);
  const stopped = r.status === "error" && r.error === "Stopped.";
  if (r.status === "error" && !stopped) setError(r.error);
  trackModelDownload({ outcome: r.status === "ok" ? "done" : stopped ? "stopped" : "failed", update, seconds: Math.round((Date.now() - started) / 1000) });
  await refreshLocal();
}

export const cancelLocal = () => void commands.localModelCancel();

export async function removeLocal(): Promise<void> {
  const r = await commands.localModelRemove();
  if (r.status === "error") setError(r.error);
  await refreshLocal();
}

/** Bytes of a newer fine-tune to download when an older one is installed (0: up to date, or not installed). */
export const updateBytes = (i: LocalModelInfo | null): number => (i?.installed ? (i.updateBytes ?? 0) : 0);

// "Later" on the update banner: hidden until the app starts again.
const [updateLater, setUpdateLater] = createSignal(false);
export { updateLater, setUpdateLater };

/** Downloads the newer fine-tune (the install downloads only what is missing), then the next chat runs it. */
export const updateLocal = installLocal;
