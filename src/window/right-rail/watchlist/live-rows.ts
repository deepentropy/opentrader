/*
 * Web build: the server streams at most WEB_LIVE_SYMBOLS symbols to one page (#358). In a longer list the rows on
 * screen go first on the live feed (data/subscriptions.ts), and follow the scroll, so what the user looks at keeps
 * its live prices; the rest of the list fills what is left, in its order. The desktop app streams the whole list.
 */
import { createEffect, on, onCleanup } from "solid-js";
import { clearSubscription, setSubscription, WEB_LIVE_SYMBOLS } from "../../../data/subscriptions";
import { isSectionId } from "../../../data/watchlist-store";
import { isTauri } from "../../shell/window-bridge";
import { type WatchlistCx } from "./context";

const KEY = "watchlist-shown";

/** Returns the rows container's scroll handler. */
export function createLiveRows(cx: WatchlistCx): () => void {
  if (isTauri()) return () => {};
  let timer: number | undefined;
  const update = () => {
    timer = undefined;
    const el = cx.rowsEl;
    if (!el || cx.allRows().length <= WEB_LIVE_SYMBOLS) {
      clearSubscription(KEY);
      return;
    }
    const box = el.getBoundingClientRect();
    const shown: string[] = [];
    for (const row of el.querySelectorAll<HTMLElement>("[data-item-id]")) {
      const id = row.dataset.itemId;
      if (!id || isSectionId(id)) continue;
      const r = row.getBoundingClientRect();
      if (r.bottom > box.top && r.top < box.bottom) shown.push(id);
    }
    setSubscription(KEY, shown);
  };
  // After the scroll settles: each change of the set is a new subscription.
  const later = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(update, 250);
  };
  createEffect(on(() => [cx.active()?.id, cx.allRows().length, cx.settings().tableView], later));
  window.addEventListener("resize", later);
  onCleanup(() => {
    window.clearTimeout(timer);
    window.removeEventListener("resize", later);
    clearSubscription(KEY);
  });
  return later;
}
