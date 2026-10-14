/*
 * Drawing tool state of the window, set from the left drawing toolbar: the
 * armed tool and glyph, the Cursor group's interaction mode, the drawing sync
 * scope, the magnet and "stay in drawing mode" toggles, the Hide / Lock modes
 * and the locked-drawings removal choices. Module-level signals (one App per
 * window); the persisted ones follow other windows' writes through kv.
 */
import { createSignal } from "solid-js";
import * as kv from "../../data/kv";
import type { CursorMode } from "../../data/drawing-toolbar";
import type { ObjectsMode, SyncMode } from "./DrawingToolbar";

const [armedTool, setArmedTool] = createSignal<string | null>(null);
// Chart interaction mode set by the Cursor group (cross / dot / arrow /
// eraser / demonstration). Shared with the chart host + overlay.
const [cursorMode, setCursorMode] = createSignal<CursorMode>("cross");
// Glyph staged by the FontIconPicker, consumed when a `font-icon` is placed.
const [armedGlyph, setArmedGlyph] = createSignal<string>("");
export { armedTool, setArmedTool, cursorMode, setCursorMode, armedGlyph, setArmedGlyph };

// ── Drawing sync scope ───────────────────────────────────────────────────
// Drawing-sync scope (drawingSyncMode button), persisted so the toolbar
// dropdown and the store key agree. Default "global" = the out-of-box
// behaviour. Live cross-window sync of the choice itself.
const [syncMode, setSyncModeRaw] = createSignal<SyncMode>(
  ((): SyncMode => {
    const v = kv.getItem("ot:drawing-sync");
    return v === "none" || v === "layout" || v === "global" ? v : "global";
  })(),
);
export { syncMode };
export const setSyncMode = (m: SyncMode): void => {
  setSyncModeRaw(m);
  kv.setItem("ot:drawing-sync", m);
};
kv.onExternalChange("ot:drawing-sync", () => {
  const v = kv.getItem("ot:drawing-sync");
  if (v === "none" || v === "layout" || v === "global") setSyncModeRaw(v);
});

// ── Magnet + stay in drawing mode ────────────────────────────────────────
// Bottom-rail toggles for the drawing toolbar.
const [magnetOn, setMagnetOn] = createSignal(false);
export { magnetOn, setMagnetOn };
// Magnet strength + "snap to indicator" — the split-control sub-options.
// Persisted (desktop preference) unlike the session-only on/off toggle.
const [magnetMode, setMagnetModeRaw] = createSignal<"weak" | "strong">(
  kv.getItem("ot:magnet-mode") === "strong" ? "strong" : "weak",
);
export { magnetMode };
export const setMagnetMode = (m: "weak" | "strong"): void => {
  setMagnetModeRaw(m);
  kv.setItem("ot:magnet-mode", m);
};
const [magnetSnapsToIndicators, setMagnetSnapsRaw] = createSignal(
  kv.getItem("ot:magnet-snap-indicators") === "true",
);
export { magnetSnapsToIndicators };
export const setMagnetSnapsToIndicators = (v: boolean): void => {
  setMagnetSnapsRaw(v);
  kv.setItem("ot:magnet-snap-indicators", String(v));
};
// Live cross-window sync for the two magnet sub-options (raw setters, no echo).
kv.onExternalChange("ot:magnet-mode", () =>
  setMagnetModeRaw(kv.getItem("ot:magnet-mode") === "strong" ? "strong" : "weak"));
kv.onExternalChange("ot:magnet-snap-indicators", () =>
  setMagnetSnapsRaw(kv.getItem("ot:magnet-snap-indicators") === "true"));
const [stayMode, setStayMode] = createSignal(false);
export { stayMode, setStayMode };

// ── Hide / Lock ──────────────────────────────────────────────────────────
// Lock-all / Hide-all are PERSISTENT toggle modes: they stay on even with
// zero drawings and auto-apply to drawings placed later (see the drawing
// store's addDrawingToSymbol), so the buttons are always meaningful to
// click. The mode signals — not a derived "every drawing has the flag" read —
// drive the buttons' active visual. `indicatorsHidden` mirrors this for
// studies.
const [lockDrawingsMode, setLockDrawingsMode] = createSignal(false);
const [hideDrawingsMode, setHideDrawingsMode] = createSignal(false);
const [indicatorsHidden, setIndicatorsHidden] = createSignal(false);
/** Lock indicators: studies cannot be dragged on the chart. */
const [indicatorsLocked, setIndicatorsLocked] = createSignal(false);
export {
  lockDrawingsMode,
  setLockDrawingsMode,
  hideDrawingsMode,
  setHideDrawingsMode,
  indicatorsHidden,
  setIndicatorsHidden,
  indicatorsLocked,
  setIndicatorsLocked,
};
// Each button keeps one mode (drawings, indicators or all; saved); see the
// drawing store's toggleHide / toggleLock.
const readMode = (key: string, def: ObjectsMode): ObjectsMode => {
  const v = kv.getItem(key);
  return v === "drawings" || v === "indicators" || v === "all" ? v : def;
};
const [hideMode, setHideMode] = createSignal<ObjectsMode>(readMode("ot:hide-mode", "drawings"));
const [lockMode, setLockMode] = createSignal<ObjectsMode>(readMode("ot:lock-mode", "all"));
export { hideMode, setHideMode, lockMode, setLockMode };

// ── Removal of locked drawings ───────────────────────────────────────────
// Locked drawings in a removal (reference rules): a confirm asks whether
// to remove them too ("Don't show again" stores the answer of the next
// click); with "Always remove locked drawings" (Remove options switch) or a
// stored answer, no question. Kept locked drawings stay; the rest goes.
const [alwaysRemoveLocked, setAlwaysRemoveLocked] = createSignal(kv.getItem("ot:delete-locked-drawings") === "1");
const [lockedNoConfirm, setLockedNoConfirm] = createSignal(kv.getItem("ot:delete-locked-no-confirm") === "1");
export { alwaysRemoveLocked, lockedNoConfirm };
export const storeAlwaysRemoveLocked = (v: boolean): void => {
  setAlwaysRemoveLocked(v);
  kv.setItem("ot:delete-locked-drawings", v ? "1" : "0");
};
export const storeLockedNoConfirm = (v: boolean): void => {
  setLockedNoConfirm(v);
  kv.setItem("ot:delete-locked-no-confirm", v ? "1" : "0");
};
/** Remove options switch: on also stops the question. */
export function toggleAlwaysRemoveLocked(): void {
  const next = !alwaysRemoveLocked();
  storeAlwaysRemoveLocked(next);
  if (next) storeLockedNoConfirm(true);
}
