/*
 * Stock screener backend calls (Rust `screener_*` commands). The backend
 * polls the market every 10 s while at least one owner has the screener open
 * and emits `screener-update` after every poll; scans run on its in-memory
 * table.
 */
import { commands, events, type FieldInfo, type ScanRequest, type ScanResult, type ScreenerProgress, type ScreenerStatus, type ScreenerUpdate } from "../bindings";
import { isCustomField } from "./screener-catalog";

async function unwrap<T>(p: Promise<{ status: "ok"; data: T } | { status: "error"; error: string }>): Promise<T> {
  const r = await p;
  if (r.status === "error") throw new Error(r.error);
  return r.data;
}

/** Start polling for `owner` (window label + ":screener"). */
export const screenerOpen = (owner: string): Promise<ScreenerStatus> => unwrap(commands.screenerOpen(owner));
/** Stop polling for `owner`. */
export const screenerClose = (owner: string): Promise<null> => unwrap(commands.screenerClose(owner));
/** Scan the market table. The custom lengths it reads ("EMA137") are asked for first: the backend computes them
 *  from the closes file and they hold values from its next update (null before). */
export const screenerScan = async (req: ScanRequest): Promise<ScanResult> => {
  const custom = customFieldsOf(req).filter((f) => !askedCustom.has(f));
  if (custom.length) {
    for (const f of custom) askedCustom.add(f);
    await unwrap(commands.screenerCustomFields(custom)).catch((e) => console.warn("[screener] custom lengths", e));
  }
  return unwrap(commands.screenerScan(req));
};

const askedCustom = new Set<string>();

/** Custom-length field ids a scan reads: columns, filter sides, sort. */
export function customFieldsOf(req: ScanRequest): string[] {
  const ids = new Set<string>();
  const visit = (v: unknown) => {
    if (typeof v === "string" && isCustomField(v)) ids.add(v);
    else if (Array.isArray(v)) v.forEach(visit);
  };
  for (const c of req.columns) visit(c);
  for (const cl of req.filter) {
    visit(cl.left);
    visit(cl.right);
  }
  if (req.sort) visit(req.sort.sortBy);
  return [...ids];
}
/** Download progress of what the next complete table waits on (the loading wheel). */
export const screenerProgress = (): Promise<ScreenerProgress> => unwrap(commands.screenerProgress());
export const screenerFields = (): Promise<FieldInfo[]> => unwrap(commands.screenerFields());
/** Distinct values of a text field (sector, industry) in the loaded data. */
export const screenerValues = (field: string): Promise<string[]> => unwrap(commands.screenerValues(field));

/** Subscribe to the per-poll update event. Returns the unlisten function. */
export function onScreenerUpdate(cb: (u: ScreenerUpdate) => void): Promise<() => void> {
  return events.screenerUpdate.listen((e) => cb(e.payload));
}

/** Backend poll period (the refresh countdown restarts at every update). */
export const POLL_MS = 10_000;
