/*
 * Heavy script warning (#325): the editor's banner when the shown script's study took close to the runtime limit to
 * calculate (the worker's watchdog stops a run past it), as the reference app warns before its own limit. A closed
 * warning stays hidden for that script for a day; "the profiler." in it turns Profiler mode on and closes it.
 */
import * as kv from "../../data/kv";
import type { OakCalculation } from "./engine";

/** The warning shows past three quarters of the limit: the reference's margin on its base plan (15 s of 20 s). */
export const HEAVY_SHARE = 0.75;

/** A closed warning stays hidden this long. */
const CLOSED_FOR_MS = 86_400_000;

const KEY = "ot:oakscript:heavyClosed";

/** The calculation took close to its limit. */
export function isHeavy(c: OakCalculation | undefined): boolean {
  return !!c && c.ms > c.limitMs * HEAVY_SHARE;
}

/** The limit as the warning gives it, in whole seconds. */
export function limitSeconds(c: OakCalculation): number {
  return Math.round(c.limitMs / 1000);
}

/** When the warning of each script was closed (ms), the expired ones dropped. */
function closedTimes(now: number): Record<string, number> {
  let saved: unknown;
  try {
    saved = JSON.parse(kv.getItem(KEY) ?? "null");
  } catch {
    saved = null;
  }
  const out: Record<string, number> = {};
  if (saved && typeof saved === "object") {
    for (const [id, t] of Object.entries(saved)) if (typeof t === "number" && now - t <= CLOSED_FOR_MS) out[id] = t;
  }
  return out;
}

function save(times: Record<string, number>): void {
  if (Object.keys(times).length) kv.setItem(KEY, JSON.stringify(times));
  else kv.removeItem(KEY);
}

/** The warning of `scriptId` was closed less than a day ago. */
export function wasClosed(scriptId: string, now = Date.now()): boolean {
  return closedTimes(now)[scriptId] !== undefined;
}

/** Hides the warning of `scriptId` for a day (from its first close: closing it again the same day does not extend
 *  it). */
export function closeWarning(scriptId: string, now = Date.now()): void {
  const times = closedTimes(now);
  times[scriptId] ??= now;
  save(times);
}
