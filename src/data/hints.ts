/*
 * One-time chart hints (TV `setupChartEventHint`, module 934930): a hint shows
 * until its close button is pressed, then never again. TV stores that as a
 * boolean setting per hint key (e.g. "hint.demonstrationCursorSelected");
 * here it is a kv flag, shared by every window.
 */
import { createSignal, type Accessor } from "solid-js";
import * as kv from "./kv";

const cache = new Map<string, { dismissed: Accessor<boolean>; dismiss: () => void }>();

/** Reactive dismissed state + dismiss action of one hint key. */
export function hintState(key: string): { dismissed: Accessor<boolean>; dismiss: () => void } {
  const hit = cache.get(key);
  if (hit) return hit;
  const storageKey = `tv:${key}`;
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

/** TV SettingsKey.StartNotFocusedZoomHint. */
export const ZOOM_HINT = "hint.startFocusedZoom";

/** TV SettingsKey.DemostrationCursorSelectedHint. */
export const DEMONSTRATION_HINT = "hint.demonstrationCursorSelected";

/** TV SettingsKey.FinishBuildPathByDblClickHint / FinishBuildPolylineByDblClickHint. */
export const PATH_HINT = "hint.finishBuildPathByDblClick";
export const POLYLINE_HINT = "hint.finishBuildPolylineByDblClick";

/** The line-tool event hint requested (TV `createdLineTool`: the layout shows
 *  it once, see ChartGrid; `finishedLineTool` dismisses it for good; a tool
 *  change hides it). Null when none. */
const [lineToolHint, setLineToolHint] = createSignal<{ key: string; text: string } | null>(null);
export { lineToolHint, setLineToolHint };
