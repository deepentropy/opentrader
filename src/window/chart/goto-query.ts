/*
 * Go to dialog ↔ active chart (TV module 810812).
 *
 * When the dialog opens it asks the active chart (window event
 * "chart-goto-query", answered synchronously by the shown active ChartView)
 * whether it is DWM (date only: time fields disabled, date at 00:00) and for
 * its first and last fully visible bars (the Custom range start values).
 *
 * The Date tab's last submitted date + time is kept for the app session
 * (TV sessionStorage `GoToDateTabLastPickedDate`) and is the next opening's
 * start value; without it the dialog starts on today 00:00.
 */
import type { WallTime } from "./day-key";

export type GotoQuery = {
  dateOnly: boolean;
  /** First / last fully visible bars, in the chart time zone; null when no
   *  bar is fully in view. */
  visible: { from: WallTime; to: WallTime } | null;
};

export function queryGotoContext(): GotoQuery {
  const q: GotoQuery = { dateOnly: false, visible: null };
  window.dispatchEvent(new CustomEvent("chart-goto-query", { detail: q }));
  return q;
}

const LAST_DATE_KEY = "ot:goto-last-date";

export function rememberGotoDate(w: WallTime): void {
  try {
    sessionStorage.setItem(LAST_DATE_KEY, JSON.stringify(w));
  } catch {
    /* storage unavailable: nothing remembered */
  }
}

export function lastGotoDate(): WallTime | null {
  try {
    const raw = sessionStorage.getItem(LAST_DATE_KEY);
    if (!raw) return null;
    const w = JSON.parse(raw) as WallTime;
    return [w.y, w.m, w.d, w.minutes].every((n) => Number.isFinite(n)) ? w : null;
  } catch {
    return null;
  }
}
