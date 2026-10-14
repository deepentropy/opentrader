/*
 * Drawing store of the window: the drawings of every chart, keyed by a SCOPE
 * KEY derived from the sync mode, so the same drawing can be shared at three
 * scopes:
 *   none   → per pane   (`p:<paneId>:<symbol>`) — independent even same-symbol
 *   layout → per layout (`l:<tabId>:<symbol>`)  — shared across the tab's panes
 *   global → per symbol (`<symbol>`)            — shared across tabs + windows
 * The sync scope belongs to each drawing (the reference app keeps a sync
 * mode per drawing): a chart shows its pane-only, layout and global
 * drawings together, and the sync mode only picks the scope of NEW
 * drawings. A chart is addressed by a VIEW key (drawingKeyFor) that maps to
 * its three scope keys; reads concatenate them and writes put each drawing
 * back in the scope it lives in (a new one in the current mode's scope).
 * The store is a reactive scope key→list map; `drawings()` is the FOCUSED
 * pane's view; `drawingsFor(key)` gives any pane its own view. Two panes
 * sharing a scope key share those drawings.
 *
 * Also the drawing operations (place, edit, clone, reorder, remove with the
 * locked / alert confirmations, lock / hide all). Every change is persisted
 * per scope key and recorded on the undo history. Created once by App.
 */
import { createEffect, onCleanup } from "solid-js";
import { createStore } from "solid-js/store";
import type { Drawing, NewDrawing } from "lightweight-charts-drawing/core/types";
import { defaultStyleFor } from "lightweight-charts-drawing/core/specs";
import * as kv from "../../data/kv";
import { alertStore } from "../../data/alert-store";
import { ruleDrawingIds } from "../../data/alert-condition";
import { showConfirm } from "../../components/Dialogs";
import { labelForKind } from "./labels";
import { loadDrawings, saveDrawings } from "./persistence";
import { overOf, type PlacedDrawing } from "../chart/tree-order";
import type { ObjectsMode } from "./DrawingToolbar";
import type { PaneChart } from "../shell/tabs";
import type { AppTabs } from "../shell/app-tabs";
import type { DrawingSlice, UndoHistory } from "../shell/undo-history";
import { setSelectedDrawingId, setSelectedDrawingIds } from "./drawing-selection";
import {
  alwaysRemoveLocked,
  hideDrawingsMode,
  hideMode,
  indicatorsHidden,
  indicatorsLocked,
  lockDrawingsMode,
  lockedNoConfirm,
  lockMode,
  setHideDrawingsMode,
  setHideMode,
  setIndicatorsHidden,
  setIndicatorsLocked,
  setLockDrawingsMode,
  setLockMode,
  storeAlwaysRemoveLocked,
  storeLockedNoConfirm,
  syncMode,
} from "./drawing-tools-state";

const VIEW_SEP = "\u001f";
/** View key of a pane of tab `tabId`. */
export const viewKeyOf = (pane: PaneChart, tabId: string): string =>
  ["v", pane.id, tabId, pane.symbol].join(VIEW_SEP);
export const isViewKey = (key: string) => key.startsWith(`v${VIEW_SEP}`);
/** The scope keys of a view key: pane only, layout, global. */
export const scopeKeys = (view: string): string[] => {
  const [, paneId, tabId, symbol] = view.split(VIEW_SEP);
  return [`p:${paneId}:${symbol}`, `l:${tabId}:${symbol}`, symbol];
};

type ChangeMeta = { label: string; coalesceId?: string };

export function createDrawingStore(
  t: Pick<AppTabs, "tabs" | "mountedTabs" | "activeTab" | "activePaneState" | "patchActivePane">,
  undo: Pick<UndoHistory, "recordDrawingChange">,
) {
  const { tabs, mountedTabs, activeTab, activePaneState, patchActivePane } = t;

  const drawingKeyFor = (pane: PaneChart, tabId: string = activeTab().id): string => viewKeyOf(pane, tabId);
  /** The scope key new drawings of a view go to (the sync mode). */
  const modeScopeKey = (view: string): string => {
    const [p, l, g] = scopeKeys(view);
    return syncMode() === "none" ? p : syncMode() === "layout" ? l : g;
  };
  const activeDrawingKey = () => drawingKeyFor(activePaneState());

  const [drawingStore, setDrawingStore] = createStore<Record<string, Drawing[]>>(
    Object.fromEntries(scopeKeys(activeDrawingKey()).map((k) => [k, loadDrawings(k)])),
  );
  /** A scope key's drawings, or a view's drawings (global, layout, then
   *  pane-only ones). */
  const drawingsFor = (key: string): Drawing[] =>
    isViewKey(key) ? scopeKeys(key).flatMap((k) => drawingStore[k] ?? []) : drawingStore[key] ?? [];
  /** Split a view's new list into its scope keys: each drawing stays in the
   *  scope it lives in; a drawing not in any (new) goes to `newScope`. */
  function splitView(view: string, next: Drawing[], newScope = modeScopeKey(view)): DrawingSlice[] {
    const keys = scopeKeys(view);
    const owner = new Map<string, string>();
    for (const k of keys) for (const d of drawingStore[k] ?? []) owner.set(d.id, k);
    const after = new Map(keys.map((k) => [k, [] as Drawing[]]));
    for (const d of next) after.get(owner.get(d.id) ?? newScope)?.push(d);
    return keys
      .map((k) => ({ key: k, before: drawingStore[k] ?? [], after: after.get(k)! }))
      .filter((s) => s.before.length !== s.after.length || s.before.some((d, i) => d !== s.after[i]));
  }
  const drawings = () => drawingsFor(activeDrawingKey());

  /** Restore a slice without recording (undo/redo application path). */
  function restoreSlice(key: string, list: Drawing[]) {
    setDrawingStore(key, list);
    saveDrawings(key, list);
    setSelectedDrawingIds((cur) => cur.filter((id) => list.some((d) => d.id === id)));
  }

  /** Replace a scope key's drawings + persist. The per-pane mutators target the
   *  pane's scope key; the focused wrappers (object tree / selected toolbar)
   *  pass `activeDrawingKey()`. `meta` records the change on the undo stack;
   *  pass null for non-user mutations (loading a saved layout). */
  function setSlice(key: string, next: Drawing[], meta?: ChangeMeta | null) {
    if (isViewKey(key)) {
      // A view: write each scope slice the change touches (one undo entry).
      const slices = splitView(key, next);
      if (meta !== null) undo.recordDrawingChange(key, drawingsFor(key), next, meta ?? { label: "drawing change" }, slices);
      for (const s of slices) {
        setDrawingStore(s.key, s.after);
        saveDrawings(s.key, s.after);
      }
      return;
    }
    if (meta !== null) {
      undo.recordDrawingChange(key, drawingsFor(key), next, meta ?? { label: "drawing change" });
    }
    setDrawingStore(key, next);
    saveDrawings(key, next);
  }
  /** Replace the FOCUSED pane's drawings (object-tree / bottom-rail ops). */
  const setActiveDrawings = (next: Drawing[], meta?: ChangeMeta | null) =>
    setSlice(activeDrawingKey(), next, meta);
  // Live cross-window sync for drawings: when another window edits a key we
  // currently hold a slice for, re-load just that slice (setDrawingStore, not
  // setSlice — no re-persist). Keys we haven't loaded are fetched lazily on
  // first access, so they need no handling here. (Only global/symbol keys are
  // shared across windows; none/layout keys are window-local by construction.)
  onCleanup(kv.onExternalChangePrefix("ot:drawings:", (storeKey) => {
    const key = storeKey.slice("ot:drawings:".length);
    if (key in drawingStore) setDrawingStore(key, loadDrawings(key));
  }));
  const newDrawingId = () => `dw_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

  // Lazily load each scope key shown by the mounted tabs' panes into the store
  // (skips keys already loaded so edits aren't clobbered). Re-runs when the
  // pane set OR the sync mode changes (drawingKeyFor reads syncMode), so
  // switching mode pulls in the right slices. Saving is done inline on edit.
  createEffect(() => {
    const open = mountedTabs();
    for (const tab of tabs()) {
      if (!open.has(tab.id)) continue;
      for (const p of tab.panes) {
        for (const key of scopeKeys(drawingKeyFor(p, tab.id))) {
          if (!(key in drawingStore)) setDrawingStore(key, loadDrawings(key));
        }
      }
    }
  });
  // When the focused pane's scope key changes, drop the selection ONLY if the
  // selected drawing doesn't belong to the new key. (Changing symbol/pane
  // orphans the old selection → clear; but selecting a drawing on another pane
  // focuses that pane and must KEEP the just-made selection.)
  let lastSelKey = activeDrawingKey();
  createEffect(() => {
    const key = activeDrawingKey();
    if (key === lastSelKey) return;
    lastSelKey = key;
    const list = drawingsFor(key);
    setSelectedDrawingIds((cur) => cur.filter((id) => list.some((d) => d.id === id)));
  });

  // ── Per-pane drawing mutators ──────────────────────────────────────────
  // Each operates on the SCOPE KEY of the pane the user acted on (see
  // drawingKeyFor), so placing / editing on any pane lands on that pane's
  // chart. The focused wrappers below back the right-rail object tree + the
  // selected-toolbar, which follow the focused pane.

  /** Place a new drawing onto a specific pane's scope key. While Lock-all /
   *  Hide-all mode is active the new drawing inherits the flag, so the toggles
   *  keep applying to drawings created after they were turned on. */
  function addDrawingToSymbol(key: string, d: NewDrawing): string {
    const id = newDrawingId();
    const placed = { id, style: defaultStyleFor(d.kind), ...d } as Drawing;
    if (lockDrawingsMode()) placed.locked = true;
    if (hideDrawingsMode()) placed.hidden = true;
    setSlice(key, [...drawingsFor(key), placed], { label: `create ${labelForKind(d.kind)}` });
    // A chart drawn on is saved even while hidden by a smaller template.
    if (activePaneState().savedWhenHidden === false) patchActivePane({ savedWhenHidden: undefined });
    return id;
  }

  function updateDrawingForSymbol(key: string, next: Drawing) {
    setSlice(
      key,
      drawingsFor(key).map((d) => (d.id === next.id ? next : d)),
      // Drag/nudge streams coalesce into one undo entry per gesture.
      { label: `change ${labelForKind(next.kind)}`, coalesceId: `${key}:${next.id}` },
    );
  }

  /** Run a removal of drawings. A drawing that carries alerts is removed
   *  with them, after a confirmation. */
  function removingDrawings(ids: string[], run: () => void) {
    const rules = alertStore.rules().filter((r) => ruleDrawingIds(r).some((id) => ids.includes(id)));
    if (rules.length === 0) { run(); return; }
    showConfirm({
      title: "Remove drawing",
      text:
        rules.length === 1
          ? "This drawing has an alert. Removing the drawing removes the alert too."
          : `${rules.length} alerts use ${ids.length === 1 ? "this drawing" : "these drawings"}. Removing ${ids.length === 1 ? "it" : "them"} removes the alerts too.`,
      mainText: "Remove",
      cancelText: "Cancel",
      intent: "danger",
      onConfirm: () => {
        run();
        for (const r of rules) alertStore.remove(r.id);
      },
    });
  }

  /** `ids` to remove from `key`, minus the locked ones the user keeps (see
   *  drawing-tools-state for the rules). */
  function withLockedChoice(key: string, ids: string[], run: (ids: string[]) => void) {
    const locked = new Set(drawingsFor(key).filter((d) => d.locked && ids.includes(d.id)).map((d) => d.id));
    if (locked.size === 0) { run(ids); return; }
    const finish = (removeLocked: boolean) => {
      const kept = removeLocked ? ids : ids.filter((id) => !locked.has(id));
      if (kept.length) run(kept);
    };
    if (lockedNoConfirm()) { finish(alwaysRemoveLocked()); return; }
    showConfirm({
      title: "Confirm to remove locked drawings",
      text: "You have locked drawings on this symbol. Do you want to remove the locked drawings too?",
      mainText: "Yes, remove them",
      cancelText: "No, keep them",
      intent: "danger",
      doNotShow: { label: "Don't show again", checked: lockedNoConfirm, onChange: storeLockedNoConfirm },
      onConfirm: () => {
        if (lockedNoConfirm()) storeAlwaysRemoveLocked(true);
        finish(true);
      },
      onCancel: () => {
        if (lockedNoConfirm()) storeAlwaysRemoveLocked(false);
        finish(false);
      },
      onDismiss: () => {},
    });
  }

  function removeDrawingForSymbol(key: string, id: string) {
    withLockedChoice(key, [id], () => removingDrawings([id], () => {
      const victim = drawingsFor(key).find((d) => d.id === id);
      setSlice(key, drawingsFor(key).filter((d) => d.id !== id), {
        label: `remove ${victim ? labelForKind(victim.kind) : "drawing"}`,
      });
      setSelectedDrawingIds((cur) => cur.filter((x) => x !== id));
    }));
  }

  // ── Multi-select bulk mutators ─────────────────────────────────────────
  /** Replace several drawings at once (group body-drag / group nudge) — ONE
   *  slice write, so the whole gesture lands as one undo entry. */
  function updateDrawingsForSymbol(key: string, list: Drawing[]) {
    if (list.length === 0) return;
    const byId = new Map(list.map((d) => [d.id, d]));
    setSlice(
      key,
      drawingsFor(key).map((d) => byId.get(d.id) ?? d),
      { label: `move ${list.length} drawings`, coalesceId: `${key}:group-move` },
    );
  }

  /** Delete several drawings in one undo entry (multi-select Delete). */
  function removeDrawingsForSymbol(key: string, all: string[]) {
    if (all.length === 0) return;
    withLockedChoice(key, all, (ids) => removingDrawings(ids, () => {
      const set = new Set(ids);
      setSlice(key, drawingsFor(key).filter((d) => !set.has(d.id)), {
        label: `remove ${ids.length} drawings`,
      });
      setSelectedDrawingIds((cur) => cur.filter((id) => !set.has(id)));
    }));
  }

  /** Duplicate a drawing — same kind/style, points offset by a small
   *  pixel-equivalent delta so the clone is visible. Done in data space
   *  via a tiny price bump; time stays identical since we have no easy
   *  pixel→time delta here. The clone takes a new id and ends up on top. */
  function cloneDrawingForSymbol(key: string, id: string) {
    const src = drawingsFor(key).find((d) => d.id === id);
    if (!src) return;
    const newId = newDrawingId();
    const offsetPrice = (p: { time: unknown; price: number }) => ({ ...p, price: +(p.price * 1.005).toFixed(2) });
    const cloned = {
      ...src,
      id: newId,
      style: { ...src.style },
      points: src.points.map(offsetPrice),
    } as Drawing;
    // The clone keeps the source's sync scope.
    const scope = isViewKey(key) ? scopeKeys(key).find((k) => (drawingStore[k] ?? []).some((d) => d.id === id)) ?? key : key;
    setSlice(scope, [...drawingsFor(scope), cloned], { label: `clone ${labelForKind(src.kind)}` });
    setSelectedDrawingId(newId);
  }

  // Focused-pane wrappers (object tree / selected toolbar act on the focused
  // pane's scope key).
  const updateDrawing = (next: Drawing) => updateDrawingForSymbol(activeDrawingKey(), next);
  const removeDrawing = (id: string) => removeDrawingForSymbol(activeDrawingKey(), id);
  const cloneDrawing = (id: string) => cloneDrawingForSymbol(activeDrawingKey(), id);

  // ── Lock all / Hide all ────────────────────────────────────────────────
  function setDrawingsLocked(next: boolean) {
    if (next === lockDrawingsMode()) return;
    setLockDrawingsMode(next);
    setActiveDrawings(drawings().map((d) => ({ ...d, locked: next })), {
      label: next ? "lock all drawings" : "unlock all drawings",
    });
  }
  function setDrawingsHidden(next: boolean) {
    if (next === hideDrawingsMode()) return;
    setHideDrawingsMode(next);
    setActiveDrawings(drawings().map((d) => ({ ...d, hidden: next })), {
      label: next ? "hide all drawings" : "show all drawings",
    });
  }
  // Hide and Lock modes (reference rules): each button keeps one mode
  // (drawings, indicators or all; saved), the button click toggles that mode
  // and a menu row makes its mode the saved one, then toggles it. Toggling one
  // part turns the other part off; when everything is on, a part keeps only
  // itself on. "All" turns everything on, or off when everything is on.
  function toggleObjectsMode(
    m: ObjectsMode,
    cur: { drawings: boolean; indicators: boolean },
    apply: (drawings: boolean, indicators: boolean) => void,
  ) {
    const allOn = cur.drawings && cur.indicators;
    if (m === "all") apply(!allOn, !allOn);
    else if (m === "drawings") apply(allOn || !cur.drawings, false);
    else apply(false, allOn || !cur.indicators);
  }
  /** Hide button (no mode) or a Hide menu row (its mode). */
  function toggleHide(mode?: ObjectsMode) {
    if (mode) {
      setHideMode(mode);
      kv.setItem("ot:hide-mode", mode);
    }
    toggleObjectsMode(hideMode(), { drawings: hideDrawingsMode(), indicators: indicatorsHidden() }, (d, i) => {
      setDrawingsHidden(d);
      setIndicatorsHidden(i);
    });
  }
  /** Lock button (no mode) or a Lock menu row (its mode). */
  function toggleLock(mode?: ObjectsMode) {
    if (mode) {
      setLockMode(mode);
      kv.setItem("ot:lock-mode", mode);
    }
    toggleObjectsMode(lockMode(), { drawings: lockDrawingsMode(), indicators: indicatorsLocked() }, (d, i) => {
      setDrawingsLocked(d);
      setIndicatorsLocked(i);
    });
  }
  function removeAllDrawings() {
    withLockedChoice(activeDrawingKey(), drawings().map((d) => d.id), (ids) => removingDrawings(ids, () => {
      const set = new Set(ids);
      setActiveDrawings(drawings().filter((d) => !set.has(d.id)), { label: "remove all drawings" });
      setSelectedDrawingId(null);
    }));
  }

  // ── Order ──────────────────────────────────────────────────────────────
  /** Z-order via array position: end of array = topmost (rendered last + hit
   *  first). Front/back move all the way; forward/backward swap by one. */
  function reorderDrawingForSymbol(key: string, id: string, dir: "front" | "forward" | "backward" | "back") {
    const arr = drawingsFor(key).slice();
    const i = arr.findIndex((d) => d.id === id);
    if (i < 0) return;
    const [d] = arr.splice(i, 1);
    let j = i;
    if (dir === "front") j = arr.length;
    else if (dir === "back") j = 0;
    else if (dir === "forward") j = Math.min(arr.length, i + 1);
    else if (dir === "backward") j = Math.max(0, i - 1);
    arr.splice(j, 0, d);
    setSlice(key, arr, { label: `reorder ${labelForKind(d.kind)}`, coalesceId: `${key}:order:${id}` });
  }

  /** Object tree drag: the listed drawings (front first) take, in that order,
   *  the places they hold together in the list, each with the source it now
   *  sits in front of (`over`; null = behind every source). One undo step. */
  function placeDrawingsForSymbol(key: string, ids: string[], over: Record<string, string | null>) {
    const list = drawingsFor(key);
    const byId = new Map(list.map((d) => [d.id, d]));
    const backFirst = ids.filter((id) => byId.has(id)).reverse();
    const moved = new Set(backFirst);
    let k = 0;
    let changed = false;
    const next = list.map((d) => {
      if (!moved.has(d.id)) return d;
      const src = byId.get(backFirst[k++])!;
      const want = over[src.id] ?? undefined;
      if (src !== d) changed = true;
      if (overOf(src) === want) return src;
      changed = true;
      const placed: PlacedDrawing = { ...src };
      if (want === undefined) delete placed.over;
      else placed.over = want;
      return placed;
    });
    if (changed) setSlice(key, next, { label: "move objects" });
  }

  /** Move a drawing to an absolute slot in the ObjectTree's DISPLAY order
   *  (topmost-first = reverse of the array). Used by the panel's drag-to-
   *  reorder; `toDisplayIndex` is the insert position in that display list. */
  function moveDrawingToDisplayIndex(id: string, toDisplayIndex: number) {
    const display = drawings().slice().reverse();
    const from = display.findIndex((d) => d.id === id);
    if (from < 0) return;
    // Account for the removal shifting later indices down by one.
    let to = from < toDisplayIndex ? toDisplayIndex - 1 : toDisplayIndex;
    to = Math.max(0, Math.min(display.length - 1, to));
    if (to === from) return;
    const [d] = display.splice(from, 1);
    display.splice(to, 0, d);
    setActiveDrawings(display.reverse(), { label: `reorder ${labelForKind(d.kind)}` });
  }

  return {
    drawingKeyFor,
    drawingsFor,
    splitView,
    drawings,
    restoreSlice,
    setSlice,
    addDrawingToSymbol,
    updateDrawingForSymbol,
    removeDrawingForSymbol,
    updateDrawingsForSymbol,
    removeDrawingsForSymbol,
    cloneDrawingForSymbol,
    updateDrawing,
    removeDrawing,
    cloneDrawing,
    toggleHide,
    toggleLock,
    removeAllDrawings,
    reorderDrawingForSymbol,
    placeDrawingsForSymbol,
    moveDrawingToDisplayIndex,
  };
}

export type DrawingStore = ReturnType<typeof createDrawingStore>;
