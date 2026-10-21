/*
 * Order toasts: "<Type> order placed / executed / modified / cancelled /
 * rejected on [logo SYMBOL]" with a side-coloured "Buy 1" / "Sell 1 at
 * 639.75" pill. The newest one shows; older ones fold under "Show more N"
 * (expands them) with a × that clears them all. Success / info stay 10 s,
 * errors 25 s.
 */
import { For, Show, createSignal, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";
import { replayBroker } from "../../data/trading/replay-broker";
import type { TradingEvent } from "../../data/trading/types";
import { fmtPrice, fmtQty } from "./format";
import { AlertIcon, CheckIcon, CloseIcon } from "./icons";

/** placed / modified orders show a side arrow (buy up, sell down). */
type Kind = "success" | "error" | "info" | "placed";
type Toast = { id: number; kind: Kind; title: string; symbol: string; side: "buy" | "sell"; pill: string; text?: string };

const VERB: Record<TradingEvent["kind"], string> = {
  placed: "placed",
  executed: "executed",
  modified: "modified",
  cancelled: "cancelled",
  rejected: "rejected",
};

/** Toast of a trading event (exported for tests). */
export function toastOf(e: TradingEvent): Omit<Toast, "id"> {
  const kind: Kind = e.kind === "rejected" ? "error" : e.kind === "cancelled" ? "info" : e.kind === "executed" ? "success" : "placed";
  return {
    kind,
    title: `${e.label} order ${VERB[e.kind]} on`,
    symbol: e.symbol,
    side: e.side,
    pill: `${e.side === "buy" ? "Buy" : "Sell"} ${fmtQty(e.qty)}${e.price != null ? ` at ${fmtPrice(e.price)}` : ""}`,
    text: e.message,
  };
}

const SideIcon = (p: { sell: boolean }) => (
  <svg width="26" height="26" viewBox="0 0 26 26" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
    <path d={p.sell ? "M8 11l5 5 5-5" : "M8 15l5-5 5 5"} stroke-linecap="round" stroke-linejoin="round" />
  </svg>
);

const CancelledIcon = () => (
  <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true">
    <circle cx="13" cy="13" r="9" fill="currentColor" />
    <path d="M9.8 9.8l6.4 6.4M16.2 9.8l-6.4 6.4" stroke="#1f1f1f" stroke-width="1.8" stroke-linecap="round" />
  </svg>
);

export function TradingToasts() {
  const [toasts, setToasts] = createSignal<Toast[]>([]);
  const [expanded, setExpanded] = createSignal(false);
  let next = 1;
  const timers = new Set<number>();
  const dismiss = (id: number) => setToasts((l) => l.filter((t) => t.id !== id));
  const push = (t: Omit<Toast, "id">) => {
    const id = next++;
    setToasts((l) => [...l, { ...t, id }]);
    const h = window.setTimeout(() => {
      timers.delete(h);
      dismiss(id);
    }, t.kind === "error" ? 25_000 : 10_000);
    timers.add(h);
  };
  onCleanup(replayBroker.onEvent((e) => push(toastOf(e))));
  onCleanup(() => timers.forEach((h) => window.clearTimeout(h)));

  const shown = () => {
    const l = toasts();
    return expanded() ? l : l.slice(-1);
  };

  return (
    <Portal>
      <div class="trd-toasts" aria-live="polite">
        <Show when={toasts().length > 1}>
          <div class="trd-toasts-more">
            <Show when={!expanded()}>
              <button type="button" class="trd-toasts-more-btn" onClick={() => setExpanded(true)}>
                Show more <span class="trd-toasts-count">{toasts().length - 1}</span>
              </button>
            </Show>
            <button
              type="button"
              class="trd-toasts-clear"
              aria-label="Clear all"
              onClick={() => {
                setToasts([]);
                setExpanded(false);
              }}
            >
              <CloseIcon size={14} />
            </button>
          </div>
        </Show>
        <For each={shown()}>
          {(t) => (
            <div class={`trd-toast is-${t.kind}${t.kind === "placed" ? ` is-${t.side}` : ""}`} role={t.kind === "error" ? "alert" : "status"}>
              <span class="trd-toast-icon">
                {t.kind === "success" ? <CheckIcon /> : t.kind === "error" ? <AlertIcon /> : t.kind === "placed" ? <SideIcon sell={t.side === "sell"} /> : <CancelledIcon />}
              </span>
              <div class="trd-toast-body">
                <div class="trd-toast-title">
                  {t.title}{" "}
                  <span class="trd-toast-symbol">
                    <Show when={replayBroker.iconUrl(t.symbol)} fallback={<span class="trd-toast-logo is-letter">{t.symbol.split(":").pop()?.[0] ?? ""}</span>}>
                      {(src) => <img class="trd-toast-logo" src={src()} alt="" />}
                    </Show>
                    {t.symbol}
                  </span>
                </div>
                <span class={`trd-toast-pill ${t.side === "sell" ? "is-sell" : "is-buy"}`}>{t.pill}</span>
                <Show when={t.text}>
                  <div class="trd-toast-text">{t.text}</div>
                </Show>
              </div>
              <button
                type="button"
                class="trd-toast-close"
                aria-label="Close"
                onClick={() => {
                  dismiss(t.id);
                  if (toasts().length <= 1) setExpanded(false);
                }}
              >
                <CloseIcon size={14} />
              </button>
            </div>
          )}
        </For>
      </div>
    </Portal>
  );
}
