/*
 * Order toasts (.tmp/trading-panel/DESIGN.md §6): "<Type> order placed /
 * executed / partially executed / modified / cancelled / rejected on SYMBOL"
 * with a side-coloured "Buy 1 at 123.45" pill and the broker's message.
 * Success / info stay 10 s, errors 25 s. Rows that arrive already finished
 * (the lists read at connect) raise none.
 */
import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import type { Order } from "../../bindings";
import { broker } from "../../data/broker-store";
import { fmtPrice, fmtQty } from "./format";
import { AlertIcon, CheckIcon, CloseIcon, NoteIcon } from "./icons";

type Kind = "success" | "error" | "info";
type Toast = { id: number; kind: Kind; title: string; side?: "buy" | "sell"; pill?: string; text?: string };

const TYPE = { market: "Market", limit: "Limit", stop: "Stop", stopLimit: "Stop limit" } as const;
const MAX = 4;

export function TradingToasts() {
  const [toasts, setToasts] = createSignal<Toast[]>([]);
  let next = 1;
  const push = (t: Omit<Toast, "id">) => {
    const id = next++;
    setToasts((l) => [...l, { ...t, id }].slice(-MAX));
    setTimeout(() => dismiss(id), t.kind === "error" ? 25_000 : 10_000);
  };
  const dismiss = (id: number) => setToasts((l) => l.filter((t) => t.id !== id));

  const onError = (e: Event) => push({ kind: "error", title: "Broker error", text: String((e as CustomEvent).detail ?? "") });
  onMount(() => window.addEventListener("ot-trading-error", onError));
  onCleanup(() => window.removeEventListener("ot-trading-error", onError));

  // Order transitions.
  const seen = new Map<string, { status: Order["status"]; filled: number; ours: boolean; limit: number | null; stop: number | null; qty: number }>();
  createEffect(() => {
    const s = broker.state();
    if (s.connection === "disconnected") {
      seen.clear();
      setToasts([]);
      return;
    }
    for (const o of s.orders) {
      const prev = seen.get(o.id);
      const ours = prev?.ours ?? o.status === "placing";
      const filled = o.filledQty ?? 0;
      const qty = o.qty ?? 0;
      seen.set(o.id, { status: o.status, filled, ours, limit: o.limitPrice, stop: o.stopPrice, qty });
      if (!prev) continue;
      const head = `${TYPE[o.orderType] ?? o.rawType} order`;
      const price = o.orderType === "stop" || o.orderType === "stopLimit" ? o.stopPrice : o.limitPrice;
      const pill = (qty: number, px: number | null) => `${o.side === "buy" ? "Buy" : "Sell"} ${fmtQty(qty)}${px != null ? ` at ${fmtPrice(px)}` : ""}`;
      const base = { side: o.side, text: o.message ?? undefined };
      if (o.status !== prev.status) {
        if (o.status === "working" && prev.status === "placing" && ours) {
          push({ ...base, kind: "success", title: `${head} placed on ${o.ticker}`, pill: pill(qty, price), text: undefined });
        } else if (o.status === "filled") {
          push({ ...base, kind: "success", title: `${head} executed on ${o.ticker}`, pill: pill(filled || qty, o.avgFillPrice ?? price), text: undefined });
        } else if (o.status === "cancelled" && (prev.status === "working" || prev.status === "placing" || prev.status === "inactive")) {
          push({ ...base, kind: "info", title: `${head} cancelled on ${o.ticker}`, pill: pill(qty, price), text: undefined });
        } else if (o.status === "rejected") {
          push({ ...base, kind: "error", title: `${head} rejected on ${o.ticker}`, pill: pill(qty, price) });
        }
      } else if (filled > prev.filled && o.status !== "filled") {
        push({ ...base, kind: "success", title: `${head} partially executed on ${o.ticker}`, pill: pill(filled - prev.filled, o.avgFillPrice), text: undefined });
      } else if (o.status === "working" && (o.limitPrice !== prev.limit || o.stopPrice !== prev.stop || qty !== prev.qty)) {
        push({ ...base, kind: "success", title: `${head} modified on ${o.ticker}`, pill: pill(qty, price), text: undefined });
      }
    }
  });

  return (
    <Portal>
      <div class="trd-toasts" aria-live="polite">
        <For each={toasts()}>
          {(t) => (
            <div class={`trd-toast is-${t.kind}`} role={t.kind === "error" ? "alert" : "status"}>
              <span class="trd-toast-icon">
                {t.kind === "success" ? <CheckIcon /> : t.kind === "error" ? <AlertIcon /> : <NoteIcon />}
              </span>
              <div class="trd-toast-body">
                <div class="trd-toast-title">{t.title}</div>
                <Show when={t.pill}>
                  <span class={`trd-toast-pill ${t.side === "sell" ? "is-sell" : "is-buy"}`}>{t.pill}</span>
                </Show>
                <Show when={t.text}>
                  <div class="trd-toast-text">{t.text}</div>
                </Show>
              </div>
              <button type="button" class="trd-toast-close" aria-label="Close" onClick={() => dismiss(t.id)}>
                <CloseIcon size={14} />
              </button>
            </div>
          )}
        </For>
      </div>
    </Portal>
  );
}
