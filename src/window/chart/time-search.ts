/*
 * Binary searches on time-ascending data: bars (anything with a numeric
 * `time`) or plain times. One copy, so every caller agrees on what "at or
 * before" means at the edges.
 */

type Times = readonly { readonly time: unknown }[] | readonly number[];

function timeAt(items: Times, i: number): number {
  const x = items[i];
  return (typeof x === "number" ? x : x.time) as number;
}

/** Index of the first item at or after `t`; `items.length` when every item is before it. */
export function lowerBound(items: Times, t: number): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (timeAt(items, mid) < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Index of the first item after `t`; `items.length` when none is. */
export function upperBound(items: Times, t: number): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (timeAt(items, mid) <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Index of the last item at or before `t` (the bar a time falls in); -1 when every item is after it. */
export function lastAtOrBefore(items: Times, t: number): number {
  return upperBound(items, t) - 1;
}

/** Index of the item at exactly `t`; -1 when there is none. */
export function indexOfTime(items: Times, t: number): number {
  const i = lowerBound(items, t);
  return i < items.length && timeAt(items, i) === t ? i : -1;
}
