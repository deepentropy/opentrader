/*
 * Bar Replay feed of a tick chart (#377): the bars up to the replay time, then
 * the ticks after it revealed one update at a time, as the reference app
 * replays tick charts (its only update interval: 1 tick).
 *
 * A tick goes into the last bar until that bar holds N ticks, then starts the
 * next bar, as live ticks do. The bars before the replay time are whole (the
 * history groups N ticks a bar); no bar after it is known in advance: the
 * ticks build them.
 */
import type { OHLC } from "./chart-types";
import type { FeedChange } from "./replay-feed";
import { nextTickBarTime, type TickRow } from "../../data/tick-bars";

const t = (b: { time: unknown }) => b.time as number;

export class TickReplayFeed {
  /** The series drawn; also the bars Back to live leaves (they are read again). */
  shown: OHLC[];
  readonly subMode = true;
  /** No more ticks will come (the source answered a short page). */
  subDone = false;
  /** Not used on ticks: no chart bar after the replay time is loaded. */
  fullOpen = false;
  /** The next ticks to read: from this millisecond, the first `skip` of it read already. */
  fromMs: number;
  skip = 0;
  private queue: TickRow[] = [];
  /** Ticks in the last shown bar. */
  private count: number;

  constructor(
    bars: OHLC[],
    private readonly n: number,
    fromMs: number,
  ) {
    this.shown = bars;
    this.count = n;
    this.fromMs = fromMs;
  }

  get full(): OHLC[] {
    return this.shown;
  }

  get queueLength(): number {
    return this.queue.length;
  }

  /** A page of ticks read forward (see datafeed getTicksFrom). */
  pushPage(ticks: TickRow[], more: boolean, lastMs: number | null, atLast: number) {
    this.queue.push(...ticks);
    if (lastMs !== null) {
      this.skip = lastMs === this.fromMs ? this.skip + atLast : atLast;
      this.fromMs = lastMs;
    }
    if (!more) this.subDone = true;
  }

  needs(): "full" | "sub" | null {
    return this.queue.length === 0 && !this.subDone ? "sub" : null;
  }

  /** Time of the next tick (seconds), null when there is none left, undefined
   *  while more must be read. */
  nextTime(): number | null | undefined {
    if (this.queue.length > 0) return this.queue[0].timeMs / 1000;
    return this.subDone ? null : undefined;
  }

  /** Reveal the ticks up to `time` (inclusive). */
  advanceTo(time: number): FeedChange[] {
    const out: FeedChange[] = [];
    while (this.queue.length > 0 && this.queue[0].timeMs / 1000 <= time) {
      const k = this.queue.shift()!;
      const path: OHLC = { time: 0 as OHLC["time"], open: k.price, high: k.price, low: k.price, close: k.price, volume: k.volume };
      const last = this.shown[this.shown.length - 1];
      if (last && this.count < this.n) {
        const bar: OHLC = {
          time: last.time,
          open: last.open,
          high: Math.max(last.high, k.price),
          low: Math.min(last.low, k.price),
          close: k.price,
          volume: (last.volume ?? 0) + k.volume,
        };
        this.shown[this.shown.length - 1] = bar;
        this.count++;
        out.push({ bar, appended: false, path: { ...path, time: bar.time } });
      } else {
        const time = (last ? nextTickBarTime(k.timeMs, t(last)) : k.timeMs / 1000) as OHLC["time"];
        const bar: OHLC = { ...path, time };
        this.shown.push(bar);
        this.count = 1;
        out.push({ bar, appended: true, path: bar });
      }
    }
    return out;
  }

  /** Older bars loaded in front (scroll-back during the replay). */
  prepend(older: OHLC[]) {
    if (older.length > 0) this.shown.unshift(...older);
  }
}
