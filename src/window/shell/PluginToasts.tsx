/*
 * Plugins' own messages (`plugin.toast`, plugins/PROTOCOL.md): the plugin's name over its text, tinted by level, in a
 * pile of their own at the place the plugin asks for or the user picked (data/plugin-toast-piles.ts). A folded pile
 * shows its newest toast and its errors; the others are under "Show more N". Errors stay 25 s, the others 10 s. A
 * repeat counts "×N" on its toast (data/plugin-toast-gate.ts keeps a plugin from flooding the screen).
 */
import { For, Show, createSignal, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";
import { events } from "../../bindings";
import { playAlertSound } from "../../data/alert-sounds";
import { createPluginToastGate, toastKey } from "../../data/plugin-toast-gate";
import { TOAST_POSITIONS, foldedToasts, toastChoice, toastPlace, type ToastPosition } from "../../data/plugin-toast-piles";
import { AlertIcon, CloseIcon } from "../trading/icons";
import { pluginsBottom } from "./toast-stack";
import { currentWindowLabel, isTauri } from "./window-bridge";

type Level = "info" | "warn" | "error";
type Toast = { id: number; level: Level; plugin: string; text: string; key: string; count: number; place: ToastPosition };

const InfoIcon = () => (
  <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true">
    <circle cx="13" cy="8" r="1.3" fill="currentColor" />
    <path d="M13 11.5v7" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" />
  </svg>
);

export function PluginToasts() {
  const [toasts, setToasts] = createSignal<Toast[]>([]);
  let next = 1;
  const timers = new Map<number, number>();
  const dismiss = (ids: number[]) => {
    for (const id of ids) {
      window.clearTimeout(timers.get(id));
      timers.delete(id);
    }
    setToasts((l) => l.filter((t) => !ids.includes(t.id)));
  };
  /** Counted from when the toast was (last) shown. */
  const expire = (t: Toast) => {
    window.clearTimeout(timers.get(t.id));
    timers.set(t.id, window.setTimeout(() => dismiss([t.id]), t.level === "error" ? 25_000 : 10_000));
  };
  if (isTauri()) {
    const gate = createPluginToastGate();
    // Every chart window shows the toast; the main one alone plays its sound.
    const main = currentWindowLabel() === "main";
    const stop = events.pluginToast.listen(({ payload: p }) => {
      const place = toastPlace(toastChoice(), p.position);
      if (!place) return;
      const key = toastKey(p.plugin, p.level, p.message);
      const decision = gate(p.plugin, p.level, p.message, Date.now());
      if (decision === "drop") return;
      if (decision === "repeat") {
        const t = toasts().find((x) => x.key === key);
        if (!t) return;
        setToasts((l) => l.map((x) => (x === t ? { ...x, count: x.count + 1 } : x)));
        expire(t);
        return;
      }
      const level: Level = p.level === "warn" || p.level === "error" ? p.level : "info";
      const t: Toast = { id: next++, level, plugin: p.pluginName, text: p.message, key, count: 1, place };
      setToasts((l) => [...l, t]);
      expire(t);
      if (p.sound && main) playAlertSound("fired");
    });
    onCleanup(() => void stop.then((f) => f()));
  }
  onCleanup(() => timers.forEach((h) => window.clearTimeout(h)));

  return (
    <Portal>
      <For each={TOAST_POSITIONS}>
        {(place) => {
          const pile = () => toasts().filter((t) => t.place === place);
          return (
            <Show when={pile().length > 0}>
              <Pile place={place} pile={pile()} onClose={dismiss} />
            </Show>
          );
        }}
      </For>
    </Portal>
  );
}

function Pile(p: { place: ToastPosition; pile: Toast[]; onClose: (ids: number[]) => void }) {
  const [expanded, setExpanded] = createSignal(false);
  const shown = () => {
    const l = expanded() ? p.pile : foldedToasts(p.pile);
    return p.place.startsWith("top") ? [...l].reverse() : l; // the newest is the nearest to the window's edge
  };
  const folded = () => p.pile.length - shown().length;
  return (
    <div
      class={`plugin-toasts is-${p.place}`}
      style={p.place === "bottom-left" ? { bottom: `${pluginsBottom()}px` } : undefined}
      data-name="plugin-toasts"
      aria-live="polite"
    >
      <Show when={p.pile.length > 1}>
        <div class="trd-toasts-more">
          <Show when={folded() > 0}>
            <button type="button" class="trd-toasts-more-btn" onClick={() => setExpanded(true)}>
              Show more <span class="trd-toasts-count">{folded()}</span>
            </button>
          </Show>
          <button type="button" class="trd-toasts-clear" aria-label="Clear all" onClick={() => p.onClose(p.pile.map((t) => t.id))}>
            <CloseIcon size={14} />
          </button>
        </div>
      </Show>
      <For each={shown()}>
        {(t) => (
          <div class={`trd-toast is-plugin-${t.level}`} role={t.level === "error" ? "alert" : "status"}>
            <span class="trd-toast-icon">{t.level === "info" ? <InfoIcon /> : <AlertIcon />}</span>
            <div class="trd-toast-body">
              <div class="trd-toast-title" data-no-translate>
                {t.plugin}
                <Show when={t.count > 1}>
                  <span class="trd-toasts-count trd-toast-repeat ot-value">×{t.count}</span>
                </Show>
              </div>
              <div class="trd-toast-text" data-no-translate title={t.text}>
                {t.text}
              </div>
            </div>
            <button type="button" class="trd-toast-close" aria-label="Close" onClick={() => p.onClose([t.id])}>
              <CloseIcon size={14} />
            </button>
          </div>
        )}
      </For>
    </div>
  );
}
