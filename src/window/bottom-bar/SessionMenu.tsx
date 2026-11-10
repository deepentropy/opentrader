/*
 * SessionMenu — the drop-up popup from the bottom-bar session button. Ported to
 * SolidJS from the reference mock: Regular (RTH) / Extended (ETH) radio options.
 * The selection drives per-pane session filtering in the datafeed (see
 * data/datafeed.ts — getBars / getBarsBefore / bucketLiveTick).
 */
import { For, createSignal, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import { createPopover } from "../../components/popover";
import { isRtl } from "../../components/reading-direction";
// Canonical session type lives in the data layer (where the filtering happens);
// re-exported here so existing importers (BottomBar) keep their import path.
import type { SessionId } from "../../data/datafeed";
export type { SessionId };

const OPTIONS: { id: SessionId; label: string }[] = [
  { id: "RTH", label: "Regular" },
  { id: "ETH", label: "Extended" },
];

type Props = {
  anchor: DOMRect;
  active: SessionId;
  onSelect: (id: SessionId) => void;
  onClose: () => void;
};

export function SessionMenu(props: Props) {
  let popupRef: HTMLDivElement | undefined;
  const [pos, setPos] = createSignal<{ left: number; top: number } | null>(null);

  onMount(() => {
    if (popupRef) {
      const popH = popupRef.offsetHeight;
      const popW = popupRef.offsetWidth;
      const M = 4;
      // End edges aligned with the button (left edges right to left).
      let left = Math.round(isRtl() ? props.anchor.left : props.anchor.right - popW);
      let top = Math.round(props.anchor.top - popH - M);
      if (left < M) left = M;
      if (left + popW > window.innerWidth - M) left = window.innerWidth - popW - M;
      if (top < M) top = Math.round(props.anchor.bottom + M);
      setPos({ left, top });
    }
  });
  const popover = createPopover(undefined, {
    onClose: props.onClose,
    placement: false,
    press: "mousedown",
    on: { target: "window", capture: true },
    escape: "pass",
  });

  return (
    <Portal>
      <div
        ref={(el) => { popupRef = el; popover(el); }}
        class="ot-popover session-menu context-menu"
        role="menu"
        aria-label="Session"
        style={pos() ? { left: `${pos()!.left}px`, top: `${pos()!.top}px` } : { left: "-9999px", top: "-9999px" }}
      >
        <div class="session-menu-box">
          <div class="session-menu-title">Session</div>
          <For each={OPTIONS}>
            {(o) => (
              <button
                type="button"
                role="menuitemradio"
                aria-checked={o.id === props.active}
                class={`session-menu-item${o.id === props.active ? " is-active" : ""}`}
                onClick={() => { props.onSelect(o.id); props.onClose(); }}
              >
                {o.label}
              </button>
            )}
          </For>
        </div>
      </div>
    </Portal>
  );
}
