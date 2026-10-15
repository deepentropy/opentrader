/*
 * Watchlist markers: a row's colour flag and a saved list's marker (flag,
 * emoji or initial).
 */
import { Show } from "solid-js";
import { FLAG_HEX, WL_ICONS, type FlagColor } from "../../../data/watchlist";

/** Left-edge colour flag. The SVG markup is WL_ICONS.flag; CSS `color` does
 *  the tint. */
export function FlagMarker(props: { flag: FlagColor }) {
  return (
    <span
      class="watchlist-flag"
      aria-hidden="true"
      style={{ color: FLAG_HEX[props.flag] }}
      innerHTML={WL_ICONS.flag}
    />
  );
}

/** A saved list's marker: its colour flag, else its emoji, else its initial —
 *  used in the header title and the quick-switch toolbar. */
export function ListMarker(props: { flag: FlagColor | null; emoji: string | null; name: string }) {
  return (
    <Show
      when={props.flag}
      fallback={
        props.emoji
          ? <span class="watchlist-name-emoji">{props.emoji}</span>
          : <span class="watchlist-tab-initial">{props.name.charAt(0).toUpperCase()}</span>
      }
    >
      {(f) => <FlagMarker flag={f()} />}
    </Show>
  );
}
