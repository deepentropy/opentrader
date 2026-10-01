/*
 * Selected study of the focused chart, shared with the Object tree (the
 * reference app's object tree and chart share one selection). The focused
 * ChartView publishes its selection here and handles the requests below.
 */
import { createSignal } from "solid-js";

export type StudySelection = {
  id: string;
  /** "Move to" targets available for it. */
  moveAbove: boolean;
  moveBelow: boolean;
};

export const [focusedStudySelection, setFocusedStudySelection] = createSignal<StudySelection | null>(null);

/** Request: select a study on the focused chart (detail: { id }). */
export const SELECT_STUDY_EVENT = "chart-select-study";
/** Request: move the selected study to a new pane (detail: { id, where }). */
export const MOVE_STUDY_EVENT = "chart-move-study";

export function requestSelectStudy(id: string): void {
  window.dispatchEvent(new CustomEvent(SELECT_STUDY_EVENT, { detail: { id } }));
}

export function requestMoveStudy(id: string, where: "above" | "below"): void {
  window.dispatchEvent(new CustomEvent(MOVE_STUDY_EVENT, { detail: { id, where } }));
}
