/*
 * Quotes and names of an embedded widget's symbols (#339): each symbol's last
 * price and change from its snapshot, then from the live ticks while the
 * widget is up; its name, currency and logo from the symbol's reference info.
 * Kept apart from the app's watchlist quote store, which would also follow the
 * app's own lists.
 */
import { createSignal, onCleanup, type Accessor } from "solid-js";
import { createStore } from "solid-js/store";
import { getTickerInfo, getTickerSnapshot, onTradeTick } from "../../data/datafeed";
import { clearSubscription, setSubscription } from "../../data/subscriptions";

export type WidgetQuote = { last: number | null; change: number | null; changePercent: number | null };
export type WidgetInfo = { name: string | null; currency: string | null; logo: string | null };

const SUBSCRIPTION = "embed-widget";

/** The quotes and infos of `symbols` (full names), followed while the owner lives. */
export function createWidgetQuotes(symbols: Accessor<string[]>) {
  const [quotes, setQuotes] = createStore<Record<string, WidgetQuote>>({});
  const [infos, setInfos] = createStore<Record<string, WidgetInfo>>({});
  const [loaded, setLoaded] = createSignal(false);
  let alive = true;

  const load = (list: string[]) => {
    setSubscription(SUBSCRIPTION, list);
    const reads = list.map(async (s) => {
      const [snap, info] = await Promise.allSettled([getTickerSnapshot(s, () => alive), getTickerInfo(s)]);
      if (!alive) return;
      if (snap.status === "fulfilled") setQuotes(s, { last: snap.value.last, change: snap.value.change, changePercent: snap.value.changePercent });
      if (info.status === "fulfilled") setInfos(s, { name: info.value.name, currency: info.value.currency, logo: info.value.iconUrl ?? null });
    });
    void Promise.all(reads).then(() => alive && setLoaded(true));
  };
  load(symbols());

  const off = onTradeTick((t) => {
    if (!alive) return;
    const key = t.symbol.toUpperCase();
    if (!symbols().includes(key)) return;
    const cur = quotes[key];
    setQuotes(key, {
      last: t.price,
      change: t.change ?? cur?.change ?? null,
      changePercent: t.changePercent ?? cur?.changePercent ?? null,
    });
  });
  onCleanup(() => {
    alive = false;
    void off.then((f) => f());
    clearSubscription(SUBSCRIPTION);
  });

  return { quotes, infos, loaded, reload: load };
}
