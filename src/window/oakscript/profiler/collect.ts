/*
 * Worker side of profiler mode (#312): the times the timers of an instrumented script (instrument.ts) add up, by span.
 * A run calculated on all the bars starts them again; a live update adds to them, so the profile is that of the bars
 * on the chart and the updates since.
 */
import type { OakProfile } from "../engine-types";
import { PROFILE_GLOBAL, type SpanLines } from "./instrument";

export class ProfileCollector {
  private time: Float64Array;
  private count: Float64Array;
  /** Time of the runs (µs). */
  private total = 0;

  constructor(private readonly spans: SpanLines[]) {
    this.time = new Float64Array(spans.length);
    this.count = new Float64Array(spans.length);
  }

  // The timers of the instrumented code (short names: they are in every statement).
  n(): number {
    return performance.now();
  }
  x<T>(id: number, start: number, value: T): T {
    this.time[id] += performance.now() - start;
    this.count[id]++;
    return value;
  }
  y<T>(id: number, start: number, value: T): T {
    this.time[id] += performance.now() - start;
    return value;
  }
  b(id: number, start: number): void {
    this.time[id] += performance.now() - start;
    this.count[id]++;
  }

  reset(): void {
    this.time.fill(0);
    this.count.fill(0);
    this.total = 0;
  }

  /** Runs `fn` with the timers on this collector, adding its time to the total. */
  measure<T>(fn: () => T): T {
    const g = globalThis as Record<string, unknown>;
    g[PROFILE_GLOBAL] = this;
    const start = performance.now();
    try {
      return fn();
    } finally {
      this.total += performance.now() - start;
    }
  }

  /** The spans that ran, times in µs. */
  snapshot(): OakProfile {
    const lines: OakProfile["lines"] = [];
    for (let i = 0; i < this.spans.length; i++) {
      if (this.count[i] === 0 && this.time[i] === 0) continue;
      lines.push({ lines: this.spans[i], invocations: this.count[i], time: this.time[i] * 1000 });
    }
    return { total: this.total * 1000, lines };
  }
}
