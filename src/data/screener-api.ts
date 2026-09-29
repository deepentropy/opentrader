/*
 * Stock screener backend calls (Rust `screener_*` commands). The backend
 * polls the market every 10 s while at least one owner has the screener open
 * and emits `screener-update` after every poll; scans run on its in-memory
 * table.
 */
import { commands, events, type FieldInfo, type ScanRequest, type ScanResult, type ScreenerStatus, type ScreenerUpdate } from "../bindings";

async function unwrap<T>(p: Promise<{ status: "ok"; data: T } | { status: "error"; error: string }>): Promise<T> {
  const r = await p;
  if (r.status === "error") throw new Error(r.error);
  return r.data;
}

/** Start polling for `owner` (window label + ":screener"). */
export const screenerOpen = (owner: string): Promise<ScreenerStatus> => unwrap(commands.screenerOpen(owner));
/** Stop polling for `owner`. */
export const screenerClose = (owner: string): Promise<null> => unwrap(commands.screenerClose(owner));
export const screenerScan = (req: ScanRequest): Promise<ScanResult> => unwrap(commands.screenerScan(req));
export const screenerFields = (): Promise<FieldInfo[]> => unwrap(commands.screenerFields());

/** Subscribe to the per-poll update event. Returns the unlisten function. */
export function onScreenerUpdate(cb: (u: ScreenerUpdate) => void): Promise<() => void> {
  return events.screenerUpdate.listen((e) => cb(e.payload));
}

/** Backend poll period (the refresh countdown restarts at every update). */
export const POLL_MS = 10_000;
