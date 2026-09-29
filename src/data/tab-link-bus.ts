/*
 * Tab-link bus — cross-window transport for the tab-syncing (colour link)
 * feature. Windows share one origin, so a BroadcastChannel reaches them all;
 * messages are tagged with the originating window label so a window never
 * re-applies its own broadcast.
 *
 *  - symbol / interval: App posts on change and applies inbound to its tabs.
 *  - time: the time clicked in a chart of the focused tab. Not sent while the
 *    group's date-range channel is on.
 *  - dateRange: the active pane's visible from/to.
 *  - crosshair: NOT a link channel. The crosshair is mirrored to every window
 *    through its own channel, gated by "Sync crosshair across windows" and by
 *    the receiving layout's Crosshair toggle.
 *
 * Inbound time / dateRange land on the ACTIVE pane of the linked tab
 * (`chart-link-time` / `chart-link-range` window events); the tab's own layout
 * sync then spreads them. A linked tab that is not shown keeps the latest value
 * and applies it when it becomes active (opentrader does not mount hidden
 * tabs).
 */
import { createEffect, createRoot, createSignal } from "solid-js";
import { currentWindowLabel } from "../window/shell/window-bridge";
import { crosshairSyncSetting } from "../window/header/AppSettingsDialog";
import type { LinkColor, TabLinkingState } from "../window/shell/tab-linking";

type LinkMsg =
  | { kind: "symbol"; color: LinkColor; value: string; win: string }
  | { kind: "interval"; color: LinkColor; value: string; win: string }
  | { kind: "crosshair"; time: number | null; price?: number | null; win: string }
  | { kind: "dateRange"; color: LinkColor; from: number; to: number; win: string }
  | { kind: "time"; color: LinkColor; time: number; win: string };

const bus: BroadcastChannel | null =
  typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("ot:tab-link") : null;

// The active (focused) tab's link state in THIS window: its colour plus the
// group's channels. App keeps it current.
const [activeLink, setActiveLink] = createSignal<TabLinkingState | null>(null);
export { activeLink, setActiveLink };

/** This window's tabs as the bus needs them. App registers the source. */
type LinkTabs = { tabs: () => { id: string; color?: LinkColor }[]; activeId: () => string };
let linkTabs: LinkTabs | null = null;

/** Latest time / range received for a linked tab that is not shown. */
type Pending = { range?: { from: number; to: number }; time?: number };
const pending = new Map<string, Pending>();

/** "Sync crosshair across windows" (App settings): when on, every pane's
 *  crosshair is offered to the other windows. */
export function crossWindowCrosshairOn(): boolean {
  return crosshairSyncSetting();
}

export function postSymbolLink(color: LinkColor, value: string): void {
  bus?.postMessage({ kind: "symbol", color, value, win: currentWindowLabel() } satisfies LinkMsg);
}

export function postIntervalLink(color: LinkColor, value: string): void {
  bus?.postMessage({ kind: "interval", color, value, win: currentWindowLabel() } satisfies LinkMsg);
}

/** Subscribe to inbound symbol/interval link messages from other windows. */
export function onLinkChannelData(
  handler: (m: { kind: "symbol" | "interval"; color: LinkColor; value: string }) => void,
): () => void {
  if (!bus) return () => {};
  const win = currentWindowLabel();
  const onMsg = (ev: MessageEvent) => {
    const m = ev.data as LinkMsg | null;
    if (!m || m.win === win) return;
    if (m.kind === "symbol" || m.kind === "interval") handler({ kind: m.kind, color: m.color, value: m.value });
  };
  bus.addEventListener("message", onMsg);
  return () => bus.removeEventListener("message", onMsg);
}

function dispatchRange(r: { from: number; to: number }): void {
  window.dispatchEvent(new CustomEvent("chart-link-range", { detail: { from: r.from, to: r.to } }));
}

function dispatchTime(time: number): void {
  window.dispatchEvent(new CustomEvent("chart-link-time", { detail: { time } }));
}

/** Deliver a time / range to this window's tabs linked to `color`: the shown
 *  tab applies it now, the others keep it for their activation. `skipActive`
 *  is set when this window is the sender (its shown tab is the source). */
function deliver(color: LinkColor, value: Pending, skipActive: boolean): void {
  if (!linkTabs) return;
  const activeId = linkTabs.activeId();
  for (const t of linkTabs.tabs()) {
    if (t.color !== color) continue;
    if (t.id === activeId) {
      if (skipActive) continue;
      if (value.range) dispatchRange(value.range);
      if (value.time !== undefined) dispatchTime(value.time);
    } else {
      // The newest value of either kind replaces the older one.
      pending.set(t.id, value.range ? { range: value.range } : { time: value.time });
    }
  }
}

/** Only the focused window sends time / range, so a view applied by a link
 *  never echoes back. */
function canSend(): boolean {
  return typeof document === "undefined" || document.hasFocus();
}

/** The active pane's visible range changed by the user: send it to the group
 *  when its date-range channel is on. */
export function postLinkRange(from: number, to: number): void {
  const l = activeLink();
  if (!l || !l.channels.dateRange || !canSend()) return;
  deliver(l.color, { range: { from, to } }, true);
  bus?.postMessage({ kind: "dateRange", color: l.color, from, to, win: currentWindowLabel() } satisfies LinkMsg);
}

/** A chart of the focused tab was clicked at `time`: send it to the group when
 *  its time channel is on and its date-range channel is off. */
export function postLinkTime(time: number): void {
  const l = activeLink();
  if (!l || !l.channels.time || l.channels.dateRange || !canSend()) return;
  deliver(l.color, { time }, true);
  bus?.postMessage({ kind: "time", color: l.color, time, win: currentWindowLabel() } satisfies LinkMsg);
}

/**
 * Wire the bus for this window: register its tabs, apply inbound time / range
 * to the linked tabs, apply a hidden tab's pending value when it becomes
 * active, and bridge the crosshair across windows. Returns a disposer.
 */
export function initLinkBus(source: LinkTabs): () => void {
  linkTabs = source;
  const win = currentWindowLabel();

  const onMsg = (ev: MessageEvent) => {
    const m = ev.data as LinkMsg | null;
    if (!m || m.win === win) return;
    if (m.kind === "dateRange") deliver(m.color, { range: { from: m.from, to: m.to } }, false);
    else if (m.kind === "time") deliver(m.color, { time: m.time }, false);
    else if (m.kind === "crosshair") {
      if (!crosshairSyncSetting()) return;
      window.dispatchEvent(
        new CustomEvent("chart-sync-crosshair", { detail: { time: m.time, price: m.price ?? null, sourceId: -1, relayed: true } }),
      );
    }
  };

  // Crosshair out: this window's own pane crosshair events (not the relayed
  // ones, which would echo).
  const onLocalCrosshair = (e: Event) => {
    const d = (e as CustomEvent<{ time: number | null; price?: number | null; relayed?: boolean }>).detail;
    if (d.relayed || !crosshairSyncSetting()) return;
    bus?.postMessage({ kind: "crosshair", time: d.time, price: d.price ?? null, win } satisfies LinkMsg);
  };

  // A tab that became active applies what it received while hidden. Deferred
  // one task so the grid has switched its panes to this tab; a pane still
  // loading holds the target until its bars land (ChartView).
  let applyTimer: number | undefined;
  const disposeActivation = createRoot((dispose) => {
    createEffect(() => {
      const id = source.activeId();
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      // Unlinked since: the value no longer applies.
      if (!source.tabs().find((t) => t.id === id)?.color) return;
      window.clearTimeout(applyTimer);
      applyTimer = window.setTimeout(() => {
        if (p.range) dispatchRange(p.range);
        if (p.time !== undefined) dispatchTime(p.time);
      }, 0);
    });
    return dispose;
  });

  bus?.addEventListener("message", onMsg);
  window.addEventListener("chart-sync-crosshair", onLocalCrosshair);
  return () => {
    bus?.removeEventListener("message", onMsg);
    window.removeEventListener("chart-sync-crosshair", onLocalCrosshair);
    window.clearTimeout(applyTimer);
    disposeActivation();
    linkTabs = null;
    pending.clear();
  };
}
