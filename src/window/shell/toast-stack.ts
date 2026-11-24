/*
 * The piles of the bottom-left corner stand on each other: the alerts' popups, the order toasts above them, the
 * plugins' toasts on top. Each pile gives its height while it shows something.
 */
import { createSignal, onCleanup } from "solid-js";

const FOOTER = 48;
const GAP = 8;

const [alerts, setAlerts] = createSignal(0);
const [orders, setOrders] = createSignal(0);

function measure(set: (h: number) => void) {
  return (el: HTMLElement) => {
    const ro = new ResizeObserver(() => set(el.offsetHeight));
    ro.observe(el);
    onCleanup(() => {
      ro.disconnect();
      set(0);
    });
  };
}
/** Refs of the piles' elements. */
export const alertPile = measure(setAlerts);
export const orderPile = measure(setOrders);

/** Bottom of the order toasts, then of the plugins' toasts of that corner (px from the window's). */
export const ordersBottom = () => Math.max(FOOTER, alerts() ? alerts() + GAP : 0);
export const pluginsBottom = () => ordersBottom() + (orders() ? orders() + GAP : 0);
