/**
 * The popups of fired alerts, in the bottom-left corner of the window.
 *
 * One popup per fire: a 400 px card with a tinted strip holding the alarm
 * clock, "Alert on" + the symbol (opens it on the chart), the alert's message,
 * "Edit alert" and the time of the fire, closed with its cross.
 *
 * Several popups are piled up: the newest in front, up to two more showing
 * 8 px each below it, smaller. Pointing at the pile shows two buttons above
 * it: "Show more" / "Show less" with the number of popups (opens the pile into
 * a column, oldest on top) and "Close all".
 *
 * With auto-hide on, a popup leaves after 20 s spent with the user active
 * (pointer or keyboard used in the last 15 s) and the pointer off the pile.
 * A popup that leaves stops the sound of its alert.
 */
import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { tickerOf } from "../../data/symbol-name";
import { stopAlertSound } from "../../data/alert-sounds";

export type AlertToastData = {
  /** One per fire. */
  id: string;
  alertId: string;
  symbol: string;
  message: string;
  /** Epoch ms of the fire. */
  time: number;
  /** Sound key of the alert ("" = none). */
  sound: string;
};

/** Time on screen before a popup hides by itself, and the time the user
 *  counts as active after the last pointer / keyboard event. */
const HIDE_AFTER_MS = 20_000;
const ACTIVE_FOR_MS = 15_000;
/** Length of the leave animation (see `.alert-toast-item.is-leaving`). */
const LEAVE_MS = 500;

const two = (n: number) => String(n).padStart(2, "0");
function clock(ms: number): string {
  const d = new Date(ms);
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

function AlertToast(props: {
  toast: AlertToastData;
  onClose: () => void;
  onEdit: (alertId: string) => void;
  onSymbol: (symbol: string) => void;
}) {
  const ticker = () => tickerOf(props.toast.symbol);
  return (
    <div class="alert-toast" role="status">
      <div class="alert-toast-left" aria-hidden="true">
        <svg viewBox="0 0 28 28" width="28" height="28" fill="none">
          <path
            fill="currentColor"
            fill-rule="evenodd"
            d="M14 5a10 10 0 1 1 0 20 10 10 0 0 1 0-20Zm-.75 5v6.5H18V15h-3.25v-5h-1.5Z"
          />
          <path stroke="currentColor" stroke-width="1.5" d="m2.6 9 5-5.4M25.4 9l-5-5.4" />
        </svg>
      </div>
      <div class="alert-toast-body">
        <div class="alert-toast-top">
          <div class="alert-toast-header">
            <div class="alert-toast-title">
              <span class="alert-toast-title-text">Alert on</span>
              <button type="button" class="alert-toast-ticker" onClick={() => props.onSymbol(props.toast.symbol)}>
                <span class="ot-ticker-logo ot-ticker-logo--sm" aria-hidden="true">{ticker().charAt(0)}</span>
                <span class="alert-toast-ticker-text">{ticker()}</span>
              </button>
            </div>
            <div class="alert-toast-description">{props.toast.message}</div>
          </div>
          <button type="button" class="alert-toast-close" aria-label="Close" onClick={props.onClose}>
            <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
              <path stroke="currentColor" stroke-width="1.2" d="M1.5 1.5l9 9M10.5 1.5l-9 9" />
            </svg>
          </button>
        </div>
        <div class="alert-toast-foot">
          <button type="button" class="alert-toast-link" onClick={() => props.onEdit(props.toast.alertId)}>
            Edit alert
          </button>
          <span class="alert-toast-time">{clock(props.toast.time)}</span>
        </div>
      </div>
    </div>
  );
}

export function AlertToasts(props: {
  /** Oldest first. */
  toasts: AlertToastData[];
  autoHide: boolean;
  /** Take these popups out of the list. */
  onRemove: (ids: string[]) => void;
  onEdit: (alertId: string) => void;
  onSymbol: (symbol: string) => void;
}) {
  const [expanded, setExpanded] = createSignal(false);
  const [hover, setHover] = createSignal(false);
  const [leaving, setLeaving] = createSignal<ReadonlySet<string>>(new Set());
  const [frontHeight, setFrontHeight] = createSignal(0);
  let list: HTMLDivElement | undefined;

  const shown = () => props.toasts.filter((t) => !leaving().has(t.id));
  /** Place in the pile: 0 = in front. */
  const depth = (id: string) => {
    const s = shown();
    const i = s.findIndex((t) => t.id === id);
    return i < 0 ? 0 : s.length - 1 - i;
  };

  const close = (ids: string[]) => {
    const fresh = ids.filter((id) => !leaving().has(id));
    if (fresh.length === 0) return;
    setLeaving(new Set([...leaving(), ...fresh]));
    // The sound of an alert stops with its popup, unless another popup left on screen plays it too.
    const left = new Set(shown().map((t) => t.sound));
    for (const t of props.toasts) if (fresh.includes(t.id) && t.sound && !left.has(t.sound)) stopAlertSound(t.sound);
    window.setTimeout(() => {
      props.onRemove(fresh);
      setLeaving(new Set([...leaving()].filter((id) => !fresh.includes(id))));
    }, LEAVE_MS);
  };

  // Auto-hide: each popup counts the time it spends with the user active and
  // the pointer off the pile.
  const age = new Map<string, number>();
  let lastActivity = Date.now();
  onMount(() => {
    const active = () => { lastActivity = Date.now(); };
    const events = ["pointermove", "pointerdown", "keydown", "wheel"] as const;
    for (const e of events) window.addEventListener(e, active, { capture: true, passive: true });
    let prev = Date.now();
    const timer = window.setInterval(() => {
      const now = Date.now();
      const dt = now - prev;
      prev = now;
      const ids = new Set(props.toasts.map((t) => t.id));
      for (const id of [...age.keys()]) if (!ids.has(id)) age.delete(id);
      if (!props.autoHide || hover() || now - lastActivity > ACTIVE_FOR_MS) return;
      const due: string[] = [];
      for (const t of shown()) {
        const a = (age.get(t.id) ?? 0) + dt;
        age.set(t.id, a);
        if (a >= HIDE_AFTER_MS) due.push(t.id);
      }
      if (due.length) close(due);
    }, 250);
    onCleanup(() => {
      window.clearInterval(timer);
      for (const e of events) window.removeEventListener(e, active, { capture: true });
    });
  });

  // The popups behind are cut to the height of the one in front.
  createEffect(() => {
    shown();
    expanded();
    queueMicrotask(() => {
      const front = list?.querySelector<HTMLElement>(".alert-toast-item.is-front .alert-toast");
      if (front) setFrontHeight(front.offsetHeight);
    });
  });

  const behind = () => Math.min(2, Math.max(0, shown().length - 1));

  return (
    <Show when={props.toasts.length > 0}>
      <div class="alert-toasts" onPointerEnter={() => setHover(true)} onPointerLeave={() => setHover(false)}>
        <div class="alert-toasts-controls" classList={{ "is-hidden": !hover() || shown().length < 2 }}>
          <button type="button" class="alert-toasts-btn" aria-expanded={expanded()} onClick={() => setExpanded(!expanded())}>
            <span>{expanded() ? "Show less" : "Show more"}</span>
            <span class="alert-toasts-count">{shown().length}</span>
          </button>
          <button type="button" class="alert-toasts-btn is-icon" title="Close all" aria-label="Close all" onClick={() => close(props.toasts.map((t) => t.id))}>
            <svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
              <path stroke="currentColor" stroke-width="1.2" stroke-linecap="round" d="M5 5l8 8M13 5l-8 8" />
            </svg>
          </button>
        </div>
        <div
          class="alert-toasts-list"
          classList={{ "is-collapsed": !expanded() }}
          style={{ "--alert-toasts-behind": String(expanded() ? 0 : behind()), "--alert-toast-front-height": frontHeight() ? `${frontHeight()}px` : "300px" }}
          ref={list}
        >
          <For each={props.toasts}>
            {(t) => (
              <div
                class="alert-toast-item"
                classList={{ "is-leaving": leaving().has(t.id), "is-front": !leaving().has(t.id) && depth(t.id) === 0 }}
                style={{ "--alert-toast-depth": String(Math.min(depth(t.id), 3)) }}
                data-depth={leaving().has(t.id) ? undefined : Math.min(depth(t.id), 3)}
              >
                <AlertToast toast={t} onClose={() => close([t.id])} onEdit={props.onEdit} onSymbol={props.onSymbol} />
              </div>
            )}
          </For>
        </div>
      </div>
    </Show>
  );
}
