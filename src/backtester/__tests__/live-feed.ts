/** A live feed of bars for the tests of live runs (#255). */
import type { Bar } from "../types";

/** The bars of a live feed: `start` bars, then each next bar as three ticks (its open, half way, its close). */
export function liveFeed(bars: Bar[], start: number, count: number): Bar[][] {
  const feed: Bar[][] = [bars.slice(0, start)];
  for (let i = start; i < start + count && i < bars.length; i++) {
    const b = bars[i];
    const before = bars.slice(0, i);
    const mid = (b.open + b.close) / 2;
    const ticks: Bar[] = [
      { time: b.time, open: b.open, high: b.open, low: b.open, close: b.open, volume: (b.volume ?? 0) / 4 },
      { time: b.time, open: b.open, high: Math.max(b.open, mid), low: Math.min(b.open, mid), close: mid, volume: (b.volume ?? 0) / 2 },
      b,
    ];
    for (const t of ticks) feed.push([...before, t]);
  }
  return feed;
}
