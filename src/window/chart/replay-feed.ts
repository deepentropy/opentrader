/*
 * Bar Replay feed of one chart: the loaded bars cut at the replay time and
 * revealed one update at a time.
 *
 * `full` holds every loaded chart bar (the real data, frozen when the replay
 * starts); `shown` is the series the chart draws: the bars up to the replay
 * time, the last one possibly forming. On an update interval shorter than the
 * chart's, the forming bar is built from the sub-bars (open of the first,
 * running high / low, last close, summed volume) and takes the real bar's
 * values once the next bar starts. On the chart interval itself, one update
 * is one whole bar.
 */
import type { UTCTimestamp } from "lightweight-charts";
import type { OHLC } from "./chart-types";

const t = (b: { time: unknown }) => b.time as number;

/** Index of the last bar at or before `sec` (-1 when every bar is after). */
export function lastAtOrBefore(bars: readonly { time: unknown }[], sec: number): number {
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (t(bars[mid]) <= sec) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

/** Merge a sub-bar into a forming bar. */
export function mergeInto(forming: OHLC, sub: OHLC): OHLC {
  return {
    time: forming.time,
    open: forming.open,
    high: Math.max(forming.high, sub.high),
    low: Math.min(forming.low, sub.low),
    close: sub.close,
    volume: (forming.volume ?? 0) + (sub.volume ?? 0),
  };
}

/** A chart bar opened from its first sub-bar. */
function openFrom(bar: OHLC, sub: OHLC): OHLC {
  return { time: bar.time, open: sub.open, high: sub.high, low: sub.low, close: sub.close, volume: sub.volume ?? 0 };
}

/** One change of the shown series. */
export type FeedChange = { bar: OHLC; appended: boolean };

export class ReplayFeed {
  /** Every loaded chart bar (real values). */
  readonly full: OHLC[];
  /** The series drawn: bars up to the replay time. */
  shown: OHLC[];
  /** Sub-bars after the replay time, oldest first (sub mode). */
  private queue: OHLC[] = [];
  /** No more sub-bars will come (sub mode). */
  subDone = false;
  /** Bars are built from sub-bars (update interval shorter than the chart's). */
  readonly subMode: boolean;
  /** Newer chart bars than `full` holds may still be loaded (a window
   *  around an old replay time, extended as the replay moves on). */
  fullOpen = false;
  /** Index in `full` of the last shown bar. */
  private shownEnd: number;

  constructor(full: OHLC[], point: number, subMode: boolean) {
    this.full = full;
    this.subMode = subMode;
    this.shownEnd = lastAtOrBefore(full, point);
    this.shown = full.slice(0, this.shownEnd + 1);
  }

  /** Time of the first bar not loaded yet in sub mode: sub-bars are needed
   *  from here (the start of the bar the replay time falls in). */
  get subStart(): number | null {
    if (this.shownEnd >= 0) return t(this.full[this.shownEnd]);
    return this.full.length > 0 ? t(this.full[0]) : null;
  }

  /** Last sub-bar time queued (or null). */
  get queuedUntil(): number | null {
    return this.queue.length > 0 ? t(this.queue[this.queue.length - 1]) : null;
  }

  get queueLength(): number {
    return this.queue.length;
  }

  /** Sub mode, first load: the sub-bars from the start of the bar the replay
   *  time falls in. Those at or before `point` rebuild that bar when it is
   *  not complete at the replay time (a later sub-bar of it exists), so the
   *  chart does not show its future high / low / close; the rest are queued. */
  seed(subs: OHLC[], point: number) {
    const k = this.shownEnd;
    const sorted = subs.filter((s) => this.subStart === null || t(s) >= this.subStart).sort((a, b) => t(a) - t(b));
    const before = sorted.filter((s) => t(s) <= point);
    const after = sorted.filter((s) => t(s) > point);
    if (k >= 0) {
      const inBar = (s: OHLC) => lastAtOrBefore(this.full, t(s)) === k;
      const open = after.some(inBar);
      if (open) {
        const mine = before.filter(inBar);
        if (mine.length === 0) {
          // The bar starts after the replay time: hidden.
          this.shownEnd = k - 1;
          this.shown = this.full.slice(0, k);
        } else {
          let bar = openFrom(this.full[k], mine[0]);
          for (const s of mine.slice(1)) bar = mergeInto(bar, s);
          this.shown[this.shown.length - 1] = bar;
        }
      }
    }
    this.queue = after;
  }

  /** More sub-bars (time-ascending, after the queued ones). */
  push(subs: OHLC[]) {
    const last = this.queuedUntil ?? -Infinity;
    for (const s of subs) if (t(s) > last) this.queue.push(s);
  }

  /** What must be loaded before the next update: newer chart bars, more
   *  sub-bars, or nothing. */
  needs(): "full" | "sub" | null {
    if (this.fullOpen) {
      const last = this.full[this.full.length - 1];
      if (!last || this.shownEnd + 1 >= this.full.length) return "full";
      // A sub-bar may belong to a chart bar not loaded yet.
      if (this.subMode && this.queue.length > 0 && t(this.queue[0]) >= t(last)) return "full";
    }
    if (this.subMode && this.queue.length === 0 && !this.subDone) return "sub";
    return null;
  }

  /** Newer chart bars (time-ascending). */
  appendFull(bars: OHLC[]) {
    const last = this.full.length > 0 ? t(this.full[this.full.length - 1]) : -Infinity;
    for (const b of bars) if (t(b) > last) this.full.push(b);
  }

  /** Time of the next update, null when there is nothing left, undefined when
   *  more bars must be loaded first (see {@link needs}). */
  nextTime(): number | null | undefined {
    if (this.needs() !== null) return undefined;
    if (this.subMode) {
      if (this.queue.length > 0) {
        // A real bar with no sub-bar of its own before the next one comes first.
        const next = this.full[this.shownEnd + 1];
        const q = t(this.queue[0]);
        return next && lastAtOrBefore(this.full, q) > this.shownEnd + 1 ? t(next) : q;
      }
      if (!this.subDone) return undefined;
    }
    const next = this.full[this.shownEnd + 1];
    return next ? t(next) : null;
  }

  /** Show the data up to `time` (inclusive); returns the changes made to
   *  `shown`. */
  advanceTo(time: number): FeedChange[] {
    const out: FeedChange[] = [];
    // Close the forming bar with its real values.
    const finish = () => {
      if (this.shownEnd < 0) return;
      const real = this.full[this.shownEnd];
      const last = this.shown[this.shown.length - 1];
      if (last && t(last) === t(real) && last !== real) {
        this.shown[this.shown.length - 1] = real;
        out.push({ bar: real, appended: false });
      }
    };
    const reveal = (i: number) => {
      finish();
      const bar = this.full[i];
      this.shown.push(bar);
      this.shownEnd = i;
      out.push({ bar, appended: true });
    };
    if (this.subMode) {
      /** A real bar with no sub-bar of its own before the next queued one (a
       *  gap in the sub data, or the sub data stops earlier than the chart's):
       *  it is shown whole. */
      const wholeNext = () => {
        const next = this.full[this.shownEnd + 1];
        if (!next || t(next) > time) return false;
        if (this.queue.length === 0) return this.subDone;
        return lastAtOrBefore(this.full, t(this.queue[0])) > this.shownEnd + 1;
      };
      for (;;) {
        while (wholeNext()) reveal(this.shownEnd + 1);
        if (this.queue.length === 0 || t(this.queue[0]) > time) break;
        const s = this.queue.shift()!;
        const b = lastAtOrBefore(this.full, t(s));
        // Before the shown bars (already formed): nothing to do.
        if (b < this.shownEnd) continue;
        if (b === this.shownEnd) {
          const last = this.shown[this.shown.length - 1];
          const merged = mergeInto(last, s);
          this.shown[this.shown.length - 1] = merged;
          out.push({ bar: merged, appended: false });
        } else {
          finish();
          const bar = openFrom(this.full[b], s);
          this.shown.push(bar);
          this.shownEnd = b;
          out.push({ bar, appended: true });
        }
      }
      return out;
    }
    while (this.full[this.shownEnd + 1] && t(this.full[this.shownEnd + 1]) <= time) reveal(this.shownEnd + 1);
    return out;
  }

  /** Older bars loaded in front (scroll-back during the replay). */
  prepend(older: OHLC[]) {
    if (older.length === 0) return;
    this.full.unshift(...older);
    this.shown.unshift(...older);
    this.shownEnd += older.length;
  }
}

/** Seconds as a chart time. */
export const asTime = (sec: number) => sec as UTCTimestamp;
