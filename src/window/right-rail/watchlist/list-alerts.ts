/*
 * List alerts of the watchlists: the app-lifetime evaluation (module
 * singleton, runs whether or not the panel is mounted) and the fire itself.
 * A mounted panel listens for fires to show its toast.
 */
import { createEffect, createRoot } from "solid-js";
import { watchlistStore, firedAlerts, saveFiredAlerts } from "../../../data/watchlist-store";
import { currentWindowLabel } from "../../shell/window-bridge";
import { quoteFor as liveQuoteFor } from "../../../data/quotes";
import { alertStore } from "../../../data/alert-store";
import { alertSettings } from "../../../data/alert-settings";
import { playAlertSound } from "../../../data/alert-sounds";
import { setSubscription } from "../../../data/subscriptions";
import { cachedSymbolSessions, localDay } from "../../../data/session";

// ── List alerts (module singleton) ───────────────────────────────────────────
// Notify when a symbol of a list with an alert moves by at least the list's
// threshold (|session change %|). Every list with an alert is checked, not
// only the open one (its symbols are kept subscribed below). A symbol fires
// once per trading day (its exchange day), so the alert re-arms each day.
// A fire follows the alert settings (system notification, sound) and is
// written to the Alerts log. The evaluation loop must not depend on the panel
// being mounted (RightRail unmounts it with the tab), so it lives in a
// detached root at module scope — the same hoisting pattern as
// data/quotes.ts. The fired (list, symbol, day) dedupe set lives in
// watchlist-store (so deleteList can clear a removed list's entries); saving
// a new threshold re-arms the list (clearFiredForList, from saveAlert).

// Mounted panels subscribe here for the in-panel toast; the OS notification
// below fires whether or not any panel is showing.
export type ListAlertListener = (title: string, body: string) => void;
/** Sound of a list alert fire (the alert dialog's default sound). */
const LIST_ALERT_SOUND = "fired";
export const listAlertListeners = new Set<ListAlertListener>();

function fireListAlert(title: string, body: string, listId: string, symbol: string): void {
  alertStore.recordFire({
    alertId: `list:${listId}`,
    symbol,
    resolution: "1D",
    name: title,
    message: body,
    fireTime: Date.now(),
    barTime: null,
    soundFile: LIST_ALERT_SOUND,
    logoUrl: null,
  });
  playAlertSound(LIST_ALERT_SOUND);
  try {
    if (alertSettings.systemNotifications() && typeof Notification !== "undefined" && Notification.permission === "granted") {
      new Notification(title, { body });
    }
  } catch {
    /* notifications unavailable — a mounted panel's toast still covers it */
  }
  for (const fn of [...listAlertListeners]) {
    try {
      fn(title, body);
    } catch {
      /* a bad listener must not break firing */
    }
  }
}

// App-lifetime evaluation: re-runs when the active list, its threshold, or any
// member quote changes (quotes.ts keeps the subscription alive for these rows).
// Main window ONLY — detached windows load this same module, and a second
// evaluator would double-fire every list alert (the kv dedupe set only syncs
// after its 120ms debounce). Secondary windows still render the panel UI.
createRoot(() => {
  // Symbols of every list with an alert stay subscribed (quotes.ts keeps
  // only the open list's symbols).
  createEffect(() => {
    const syms = new Set<string>();
    for (const l of watchlistStore.lists()) {
      if (watchlistStore.alertFor(l.id) == null) continue;
      for (const r of [...l.groups.flatMap((g) => g.rows), ...l.extras]) syms.add(r.ticker.toUpperCase());
    }
    setSubscription("list-alerts", [...syms]);
  });
  createEffect(() => {
    if (currentWindowLabel() !== "main") return;
    // Drop fired keys older than a week (one per symbol and day).
    const today = Math.floor(Date.now() / 86400000);
    let pruned = false;
    for (const k of [...firedAlerts]) {
      const d = Number(k.split(":").pop());
      if (Number.isFinite(d) && d > 10000 && d < today - 7) {
        firedAlerts.delete(k);
        pruned = true;
      }
    }
    if (pruned) saveFiredAlerts();
    for (const list of watchlistStore.lists()) {
      const threshold = watchlistStore.alertFor(list.id);
      if (threshold == null) continue;
      const rows = [...list.groups.flatMap((g) => g.rows), ...list.extras];
      for (const r of rows) {
        const cp = liveQuoteFor(r.ticker)?.changePercent ?? null;
        if (cp == null || Math.abs(cp) < threshold) continue;
        // Once per symbol per trading day (exchange day; local day until the
        // symbol's session is known).
        const tz = cachedSymbolSessions(r.ticker)?.timeZone;
        const day = tz ? localDay(tz, Date.now() / 1000) : Math.floor((Date.now() - new Date().getTimezoneOffset() * 60000) / 86400000);
        const key = `${list.id}:${r.short.toUpperCase()}:${day}`;
        if (firedAlerts.has(key)) continue;
        firedAlerts.add(key);
        saveFiredAlerts();
        fireListAlert(
          `Alert · ${list.name}`,
          `${r.short.toUpperCase()} ${cp >= 0 ? "+" : ""}${cp.toFixed(2)}%`,
          list.id,
          r.ticker,
        );
      }
    }
  });
});
