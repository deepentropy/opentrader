/*
 * Flag colour popup (the reference app's symbol marker popup): opened right
 * of a flag button when it flags a symbol, a row of the flag colours; a pick
 * recolours the flag. Closes when the mouse leaves the button and the popup,
 * or on a click outside.
 */
import { For, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import { FLAG_HEX, type FlagColor } from "../../data/watchlist";
import { FLAG_COLORS } from "../../data/symbol-flags";

export function FlagColorPopup(props: {
  /** The flag button (position + mouse leave). */
  anchor: HTMLElement;
  value: FlagColor | null;
  onPick: (c: FlagColor) => void;
  onClose: () => void;
}) {
  let root: HTMLDivElement | undefined;
  const r = props.anchor.getBoundingClientRect();
  onMount(() => {
    let timer = 0;
    const leave = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (!props.anchor.matches(":hover") && !root?.matches(":hover")) props.onClose();
      }, 150);
    };
    const down = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!root?.contains(t) && !props.anchor.contains(t)) props.onClose();
    };
    props.anchor.addEventListener("mouseleave", leave);
    document.addEventListener("mousedown", down, true);
    onCleanup(() => {
      window.clearTimeout(timer);
      props.anchor.removeEventListener("mouseleave", leave);
      document.removeEventListener("mousedown", down, true);
    });
  });
  return (
    <Portal>
      <div
        ref={root}
        class="ot-flag-popup"
        style={{ left: `${r.right}px`, top: `${r.top + r.height / 2}px` }}
        onMouseLeave={() => {
          if (!props.anchor.matches(":hover")) props.onClose();
        }}
      >
        <span class="ot-flag-popup-arrow" aria-hidden="true" />
        <div class="ot-flag-popup-row" role="group" aria-label="Flag colour">
          <For each={FLAG_COLORS}>
            {(c) => (
              <button
                type="button"
                role="menuitemradio"
                aria-checked={props.value === c}
                aria-label={`Set ${c} flag`}
                class="watchlist-ctx-flag-swatch"
                classList={{ selected: props.value === c }}
                onClick={() => props.onPick(c)}
              >
                <span class="watchlist-ctx-flag-dot" style={{ "background-color": FLAG_HEX[c] }} />
              </button>
            )}
          </For>
        </div>
      </div>
    </Portal>
  );
}
