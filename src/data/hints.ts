/*
 * One-time chart hints: a hint shows until its close button is pressed, then
 * never again. The dismissed state is a boolean kv flag per hint key (e.g.
 * "hint.demonstrationCursorSelected"), shared by every window.
 */
import { createSignal, type Accessor } from "solid-js";
import * as kv from "./kv";

const cache = new Map<string, { dismissed: Accessor<boolean>; dismiss: () => void }>();

/** Reactive dismissed state + dismiss action of one hint key. */
export function hintState(key: string): { dismissed: Accessor<boolean>; dismiss: () => void } {
  const hit = cache.get(key);
  if (hit) return hit;
  const storageKey = `ot:${key}`;
  const [dismissed, setDismissed] = createSignal(kv.getItem(storageKey) === "1");
  kv.onExternalChange(storageKey, () => setDismissed(kv.getItem(storageKey) === "1"));
  const state = {
    dismissed,
    dismiss: () => {
      setDismissed(true);
      kv.setItem(storageKey, "1");
    },
  };
  cache.set(key, state);
  return state;
}

export const ZOOM_HINT = "hint.startFocusedZoom";

export const DEMONSTRATION_HINT = "hint.demonstrationCursorSelected";

/** Shown after the first resize of the charts of a layout. */
export const RESIZE_HINT = "hint.startResizingChartInLayout";
export const PATH_HINT = "hint.finishBuildPathByDblClick";
export const POLYLINE_HINT = "hint.finishBuildPolylineByDblClick";

/** The line-tool event hint requested (on line-tool creation the layout shows
 *  it once, see ChartGrid; finishing the line tool dismisses it for good; a
 *  tool change hides it). Null when none. */
const [lineToolHint, setLineToolHint] = createSignal<{ key: string; text: string } | null>(null);
export { lineToolHint, setLineToolHint };
