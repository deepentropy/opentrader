/*
 * A watchlist row's flag spot, the 15 px gutter before the symbol (reference behaviour):
 * - a flagged symbol shows its colour flag there, any other row a grey flag while hovered;
 * - a click on an unflagged symbol flags it with the last used colour and opens a strip of the colours beside
 *   the flag, a click on a flagged symbol unflags it;
 * - on a symbol of a selection of several, a click flags or unflags the selection, with no strip.
 * The strip closes on a pick, when the pointer leaves the flag and the strip, and on a scroll.
 */
import { For, Show, createEffect, createSignal, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";
import { FLAG_HEX, type FlagColor, type Row } from "../../../data/watchlist";
import { FLAG_COLORS, flagOf, lastFlagColor } from "../../../data/symbol-flags";
import { watchlistStore } from "../../../data/watchlist-store";
import { isRtl } from "../../../components/reading-direction";
import { translateWith } from "../../../i18n/translator";
import { WL_ICONS } from "./ui";

/** A flag's colour under the pointer. */
const FLAG_HOVER_HEX: Partial<Record<FlagColor, string>> = {
  red: "#f23645",
  blue: "#0c3299",
  green: "#43a047",
  orange: "#f57f17",
  purple: "#7b1fa2",
  cyan: "#00b8d4",
  pink: "#ec407a",
};

const SET_FLAG_LABEL: Partial<Record<FlagColor, string>> = {
  red: "Set red flag",
  blue: "Set blue flag",
  green: "Set green flag",
  orange: "Set orange flag",
  purple: "Set purple flag",
  cyan: "Set cyan flag",
  pink: "Set pink flag",
};

/** The current colour in the strip: a ring around a dot. */
const RING_DOT =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path fill="currentColor" fill-rule="evenodd" d="M0 8a8 8 0 1 0 16 0A8 8 0 1 0 0 8zm2 0a6 6 0 1 0 12 0A6 6 0 1 0 2 8zm2 0a4 4 0 1 0 8 0 4 4 0 1 0-8 0"/></svg>';

// One strip at a time, for the flag element it was opened from.
const [stripFor, setStripFor] = createSignal<HTMLElement | null>(null);

export function FlagSpot(props: {
  row: Row;
  /** The selected rows (symbols only). */
  selectedRows: () => Row[];
  /** Flag the rows with the last colour, or unflag them when all are flagged (asks first for several). */
  toggleFlags: (rows: Row[]) => void;
}) {
  let spot!: HTMLSpanElement;
  let strip: HTMLDivElement | undefined;
  const flag = () => flagOf(props.row.ticker);
  const open = () => stripFor() === spot;
  const close = () => {
    if (open()) setStripFor(null);
  };

  const onClick = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const sel = props.selectedRows();
    if (sel.length > 1 && sel.some((r) => r.ticker === props.row.ticker)) {
      close();
      props.toggleFlags(sel);
      return;
    }
    if (flag()) {
      watchlistStore.setRowsFlag([props.row.ticker], null);
      close();
      return;
    }
    if (watchlistStore.setRowsFlag([props.row.ticker], lastFlagColor())) setStripFor(spot);
  };

  const pick = (c: FlagColor) => {
    watchlistStore.setRowsFlag([props.row.ticker], c);
    close();
  };

  // Leaving the flag for anything but the strip, or the strip for anything but the flag, closes it.
  const leaves = (e: MouseEvent, other: Element | undefined) => {
    const to = e.relatedTarget as Node | null;
    if (!to || !other?.contains(to)) close();
  };

  createEffect(() => {
    if (!open()) return;
    const onScroll = () => close();
    window.addEventListener("scroll", onScroll, true);
    onCleanup(() => window.removeEventListener("scroll", onScroll, true));
  });
  onCleanup(close);

  const place = () => {
    const r = spot.getBoundingClientRect();
    const top = `${r.top + r.height / 2}px`;
    return isRtl() ? { top, right: `${window.innerWidth - r.left}px` } : { top, left: `${r.right}px` };
  };

  return (
    <>
      <span
        ref={spot}
        class="watchlist-flag watchlist-flag-spot ot-flip-rtl"
        classList={{ "is-flagged": !!flag(), "is-open": open() }}
        role="button"
        aria-label={translateWith("Flag/Unflag {0}", props.row.short)}
        style={flag() ? { "--wl-flag": FLAG_HEX[flag()!], "--wl-flag-hover": FLAG_HOVER_HEX[flag()!] ?? FLAG_HEX[flag()!] } : undefined}
        innerHTML={WL_ICONS.flag}
        onMouseDown={(e) => {
          // Neither a row drag nor a row selection starts on the flag.
          e.preventDefault();
          e.stopPropagation();
        }}
        onClick={onClick}
        onDblClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        onMouseLeave={(e) => leaves(e, strip)}
      />
      <Show when={open()}>
        <Portal>
          <div ref={strip} class="wl-flag-strip" style={place()} onMouseLeave={(e) => leaves(e, spot)}>
            <div class="wl-flag-strip__wrap">
              <div class="wl-flag-strip__box" role="menu">
                <div class="wl-flag-strip__arrow" />
                <For each={FLAG_COLORS}>
                  {(c) => (
                    <button
                      type="button"
                      role="menuitemradio"
                      class="wl-flag-strip__color"
                      aria-checked={flag() === c}
                      aria-label={SET_FLAG_LABEL[c]}
                      style={{ color: FLAG_HEX[c] }}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => pick(c)}
                    >
                      <Show
                        when={flag() === c}
                        fallback={<span class="wl-flag-strip__dot"><span class="wl-flag-strip__hover-dot" /></span>}
                      >
                        <span class="wl-flag-strip__ring" innerHTML={RING_DOT} />
                      </Show>
                    </button>
                  )}
                </For>
              </div>
            </div>
          </div>
        </Portal>
      </Show>
    </>
  );
}
