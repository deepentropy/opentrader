/*
 * Per-symbol drawing persistence via localStorage. Drawings store
 * `{time, price}` data points which are JSON-safe (Time is a number for
 * intraday/UTC-timestamp charts; for business-day strings it round-trips
 * through JSON unchanged).
 */
import type { Drawing } from "lightweight-charts-drawing/core/types";
import { parseDrawings } from "lightweight-charts-drawing/core/serialize";
import * as kv from "../../data/kv";

const PREFIX = "ot:drawings:";

export function loadDrawings(symbol: string): Drawing[] {
  if (!symbol) return [];
  try {
    const raw = kv.getItem(PREFIX + symbol);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return parseDrawings(parsed);
  } catch {
    return [];
  }
}

function writeDrawings(symbol: string, drawings: Drawing[]): void {
  try {
    if (drawings.length === 0) {
      kv.removeItem(PREFIX + symbol);
    } else {
      kv.setItem(PREFIX + symbol, JSON.stringify(drawings));
    }
  } catch {
    // ignore quota / serialization errors
  }
}

// ── Drag-time persistence deferral ──────────────────────────────────────────
// A live drag fires saveDrawings every pointermove frame. The reactive store
// must still update each frame (so all panes mirror the move live), but the
// expensive JSON.stringify + write only needs the *final* position. While
// suspended, saveDrawings records the latest slice per symbol instead of
// serialising; resume flushes the final state once (one write per symbol).
let persistSuspended = false;
const deferred = new Map<string, Drawing[]>();

/** Suspend drawing writes (call at drag start). */
export function suspendDrawingPersist(): void {
  persistSuspended = true;
}

/** Resume drawing writes and flush the final state touched while suspended
 *  (call at drag end). */
export function resumeDrawingPersist(): void {
  if (!persistSuspended) return;
  persistSuspended = false;
  for (const [sym, list] of deferred) writeDrawings(sym, list);
  deferred.clear();
}

/** Move the drawings saved under `from` to `to` (a bare-ticker key to its
 *  full-name key) unless `to` already has some. */
export function migrateDrawingKey(from: string, to: string): void {
  if (from === to) return;
  const raw = kv.getItem(PREFIX + from);
  if (!raw) return;
  if (!kv.getItem(PREFIX + to)) kv.setItem(PREFIX + to, raw);
  kv.removeItem(PREFIX + from);
}

export function saveDrawings(symbol: string, drawings: Drawing[]): void {
  if (!symbol) return;
  if (persistSuspended) {
    deferred.set(symbol, drawings); // O(1) — no serialize on the drag path
    return;
  }
  writeDrawings(symbol, drawings);
}
