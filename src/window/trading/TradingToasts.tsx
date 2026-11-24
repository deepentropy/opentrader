import { translate, translateWith } from "../../i18n/translator";
/*
 * Order toasts: "<Type> order placed / executed / modified / cancelled /
 * rejected on [logo SYMBOL]" with a side-coloured "Buy 1" / "Sell 1 at
 * 639.75" pill. The newest one shows; older ones fold under "Show more N"
 * (expands them) with a × that clears them all. Success / info stay 10 s,
 * errors 25 s.
 *
 * Plugins' own messages (`plugin.toast`, plugins/PROTOCOL.md) show in the
 * same pile: the plugin's name over its text, tinted by level, kept from
 * flooding by data/plugin-toast-gate.ts (a repeat counts "×N" on the toast).
 */
import { For, Show, createSignal, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";
import { broker } from "../../data/trading/broker";
import { tradingPrefs } from "../../data/trading/trading-prefs";
import { playAlertSound } from "../../data/alert-sounds";
import type { TradingEvent } from "../../data/trading/types";
import { fmtPrice, fmtQty } from "./format";
import { cachedSymbolSessions } from "../../data/session";
import { AlertIcon, CheckIcon, CloseIcon } from "./icons";
import { events } from "../../bindings";
import { isTauri, currentWindowLabel } from "../shell/window-bridge";
import { createPluginToastGate, toastKey } from "../../data/plugin-toast-gate";

/** placed / modified orders show a side arrow (buy up, sell down); `plugin-*` are plugins' messages by level. */
type Kind = "success" | "error" | "info" | "placed" | "plugin-info" | "plugin-warn" | "plugin-error";
type OrderToast = { kind: Exclude<Kind, `plugin-${string}`>; title: string; symbol: string; side: "buy" | "sell"; pill: string; text?: string };
/** A plugin's message: its name as the title; `key` finds a repeat, counted in `count`. */
type PluginToast = { kind: Extract<Kind, `plugin-${string}`>; title: string; text: string; key: string; count: number };
type Toast = (OrderToast | PluginToast) & { id: number };

/** The toast's title by event, `{0}` the order type ("Limit order placed on"). */
const TOAST_TITLE: Record<TradingEvent["kind"], string> = {
  placed: "{0} order placed on",
  executed: "{0} order executed on",
  modified: "{0} order modified on",
  cancelled: "{0} order cancelled on",
  rejected: "{0} order rejected on",
};

/** Toast of a trading event (exported for tests). */
export function toastOf(e: TradingEvent): OrderToast {
  const kind: Kind = e.kind === "rejected" ? "error" : e.kind === "cancelled" ? "info" : e.kind === "executed" ? "success" : "placed";
  return {
    kind,
    title: translateWith(TOAST_TITLE[e.kind], translate(e.label)),
    symbol: e.symbol,
    side: e.side,
    pill: `${e.side === "buy" ? "Buy" : "Sell"} ${fmtQty(e.qty)}${e.price != null ? ` at ${fmtPrice(e.price, cachedSymbolSessions(e.symbol)?.mintick)}` : ""}`,
    text: e.message,
  };
}

const SideIcon = (p: { sell: boolean }) => (
  <svg width="26" height="26" viewBox="0 0 26 26" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
    <path d={p.sell ? "M8 11l5 5 5-5" : "M8 15l5-5 5 5"} stroke-linecap="round" stroke-linejoin="round" />
  </svg>
);

const InfoIcon = () => (
  <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true">
    <circle cx="13" cy="8" r="1.3" fill="currentColor" />
    <path d="M13 11.5v7" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" />
  </svg>
);

const CancelledIcon = () => (
  <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true">
    <circle cx="13" cy="13" r="9" fill="currentColor" />
    <path d="M9.8 9.8l6.4 6.4M16.2 9.8l-6.4 6.4" stroke="#1f1f1f" stroke-width="1.8" stroke-linecap="round" />
  </svg>
);

/** The body of an order toast: "<Type> order executed on [logo SYMBOL]", its pill and message. */
const OrderBody = (p: { t: OrderToast }) => (
  <div class="trd-toast-body">
    <div class="trd-toast-title">
      {p.t.title}{" "}
      <span class="trd-toast-symbol">
        <Show when={broker.iconUrl(p.t.symbol)} fallback={<span class="trd-toast-logo is-letter">{p.t.symbol.split(":").pop()?.[0] ?? ""}</span>}>
          {(src) => <img class="trd-toast-logo" src={src()} alt="" />}
        </Show>
        {p.t.symbol}
      </span>
    </div>
    <span class={`trd-toast-pill ${p.t.side === "sell" ? "is-sell" : "is-buy"}`}>{p.t.pill}</span>
    <Show when={p.t.text}>
      <div class="trd-toast-text">{p.t.text}</div>
    </Show>
  </div>
);

export function TradingToasts() {
  const [toasts, setToasts] = createSignal<Toast[]>([]);
  const [expanded, setExpanded] = createSignal(false);
  let next = 1;
  const timers = new Map<number, number>();
  const dismiss = (id: number) => {
    window.clearTimeout(timers.get(id));
    timers.delete(id);
    setToasts((l) => l.filter((t) => t.id !== id));
  };
  /** Errors stay 25 s, the others 10 s, from when they were (last) shown. */
  const expire = (id: number, kind: Kind) => {
    window.clearTimeout(timers.get(id));
    timers.set(id, window.setTimeout(() => dismiss(id), kind === "error" || kind === "plugin-error" ? 25_000 : 10_000));
  };
  const push = (t: OrderToast | PluginToast) => {
    const id = next++;
    setToasts((l) => [...l, { ...t, id } as Toast]);
    expire(id, t.kind);
  };
  onCleanup(
    broker.onEvent((e) => {
      const prefs = tradingPrefs.prefs();
      // Chart settings → Trading: Execution sound, Show only rejection notifications.
      if (e.kind === "executed" && prefs.sound) playAlertSound(prefs.sound.key, { volume: prefs.sound.volume });
      if (prefs.rejectionOnly && e.kind !== "rejected") return;
      push(toastOf(e));
    }),
  );
  if (isTauri()) {
    const gate = createPluginToastGate();
    // Every chart window shows the toast; the main one alone plays its sound.
    const main = currentWindowLabel() === "main";
    const stop = events.pluginToast.listen(({ payload: p }) => {
      const decision = gate(p.plugin, p.level, p.message, Date.now());
      const key = toastKey(p.plugin, p.level, p.message);
      if (decision === "repeat") {
        const t = toasts().find((x) => "key" in x && x.key === key);
        if (!t) return;
        setToasts((l) => l.map((x) => (x.id === t.id ? { ...x, count: (x as PluginToast).count + 1 } : x)));
        expire(t.id, t.kind);
        return;
      }
      if (decision === "drop") return;
      push({ kind: `plugin-${p.level === "warn" || p.level === "error" ? p.level : "info"}`, title: p.pluginName, text: p.message, key, count: 1 });
      if (p.sound && main) playAlertSound("fired");
    });
    onCleanup(() => void stop.then((f) => f()));
  }
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
            <div
              class={`trd-toast is-${t.kind}${t.kind === "placed" ? ` is-${t.side}` : ""}`}
              role={t.kind === "error" || t.kind === "plugin-error" ? "alert" : "status"}
            >
              <span class="trd-toast-icon">
                {t.kind === "success" ? (
                  <CheckIcon />
                ) : t.kind === "error" || t.kind === "plugin-warn" || t.kind === "plugin-error" ? (
                  <AlertIcon />
                ) : t.kind === "plugin-info" ? (
                  <InfoIcon />
                ) : t.kind === "placed" ? (
                  <SideIcon sell={t.side === "sell"} />
                ) : (
                  <CancelledIcon />
                )}
              </span>
              <Show when={"key" in t ? (t as PluginToast) : null} fallback={<OrderBody t={t as OrderToast} />}>
                {(pt) => (
                  <div class="trd-toast-body">
                    <div class="trd-toast-title" data-no-translate>
                      {pt().title}
                      <Show when={pt().count > 1}>
                        <span class="trd-toasts-count trd-toast-repeat ot-value">×{pt().count}</span>
                      </Show>
                    </div>
                    <div class="trd-toast-text" data-no-translate title={pt().text}>
                      {pt().text}
                    </div>
                  </div>
                )}
              </Show>
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
