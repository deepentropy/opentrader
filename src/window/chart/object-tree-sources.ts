/*
 * Sources of the focused chart listed in the Object tree: the main series,
 * its studies and its compared symbols. The focused ChartView publishes them
 * (per pane, front source first) and serves the tree's requests below.
 */
import { createSignal } from "solid-js";

/** Id of the main series in the tree and in a pane's saved source order. */
export const MAIN_SOURCE_ID = "_series";

export type TreeSource = {
  id: string;
  kind: "series" | "study" | "compare";
  title: string;
  /** Hidden with its eye. */
  hidden: boolean;
  /** Chart pane it is drawn in (0 = the price pane). */
  pane: number;
};

export const [focusedTreeSources, setFocusedTreeSources] = createSignal<TreeSource[]>([], {
  equals: (a, b) => JSON.stringify(a) === JSON.stringify(b),
});

/** Request: show / hide a source (detail: { id }). */
export const TREE_HIDE_EVENT = "chart-tree-toggle-hide";
/** Request: remove a study or a compared symbol (detail: { id }). */
export const TREE_REMOVE_EVENT = "chart-tree-remove";
/** Request: put a source right above / below another one of its pane
 *  (detail: { id, target, below }). */
export const TREE_MOVE_EVENT = "chart-tree-move";

export function requestToggleSourceHidden(id: string): void {
  window.dispatchEvent(new CustomEvent(TREE_HIDE_EVENT, { detail: { id } }));
}

export function requestRemoveSource(id: string): void {
  window.dispatchEvent(new CustomEvent(TREE_REMOVE_EVENT, { detail: { id } }));
}

export function requestMoveSource(id: string, target: string, below: boolean): void {
  window.dispatchEvent(new CustomEvent(TREE_MOVE_EVENT, { detail: { id, target, below } }));
}
