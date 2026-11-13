/**
 * Heavy script warning (#325): when a calculation is heavy, the day a closed warning stays hidden, and which runs of
 * the engine count as a calculation of the whole study.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const kv = vi.hoisted(() => ({ store: new Map<string, string>() }));
vi.mock("../../../data/kv", () => ({
  getItem: (k: string) => kv.store.get(k) ?? null,
  setItem: (k: string, v: string) => void kv.store.set(k, v),
  removeItem: (k: string) => void kv.store.delete(k),
}));

/** The worker: answers each run after `delay` ms (fake timers) with the live part the test sets. */
const worker = vi.hoisted(() => ({
  delay: 0,
  fullRunReason: null as string | null,
  posted: [] as { id: number; live?: { from: number } }[],
}));
vi.mock("../oakscript-worker?worker", () => ({
  default: class {
    onmessage: ((e: { data: unknown }) => void) | null = null;
    onerror: (() => void) | null = null;
    postMessage(msg: { id: number; type: string; live?: { key: string; from: number } }) {
      worker.posted.push(msg);
      setTimeout(() => {
        this.onmessage?.({
          data: { id: msg.id, type: msg.type, ok: true, result: { plots: {} }, live: { id: msg.id, delta: false, fullRunReason: worker.fullRunReason } },
        });
      }, worker.delay);
    }
    terminate() {}
  },
}));

import { HEAVY_SHARE, closeWarning, isHeavy, limitSeconds, wasClosed } from "../heavy-script";
import { OakEngine, RUN_TIMEOUT_MS, type OakCalculation } from "../engine";

describe("isHeavy", () => {
  it("is past three quarters of the limit", () => {
    expect(isHeavy(undefined)).toBe(false);
    expect(isHeavy({ ms: 3750, limitMs: 5000 })).toBe(false);
    expect(isHeavy({ ms: 3751, limitMs: 5000 })).toBe(true);
    expect(isHeavy({ ms: 20000 * HEAVY_SHARE + 1, limitMs: 20000 })).toBe(true);
  });

  it("gives the limit in seconds", () => {
    expect(limitSeconds({ ms: 0, limitMs: 5000 })).toBe(5);
    expect(limitSeconds({ ms: 0, limitMs: 20000 })).toBe(20);
  });
});

describe("closed warnings", () => {
  beforeEach(() => kv.store.clear());
  const day = 86_400_000;

  it("stay hidden a day for their script only", () => {
    closeWarning("a", 1000);
    expect(wasClosed("a", 1000 + day)).toBe(true);
    expect(wasClosed("b", 1000)).toBe(false);
    expect(wasClosed("a", 1001 + day)).toBe(false);
  });

  it("count the day from the first close", () => {
    closeWarning("a", 1000);
    closeWarning("a", 5000);
    expect(wasClosed("a", 1001 + day)).toBe(false);
  });

  it("drop the expired ones when one is closed", () => {
    closeWarning("a", 1000);
    closeWarning("b", 2000 + day);
    expect(Object.keys(JSON.parse(kv.store.get("ot:oakscript:heavyClosed")!))).toEqual(["b"]);
  });
});

describe("OakEngine calculations", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    worker.delay = 0;
    worker.fullRunReason = null;
    worker.posted = [];
  });
  afterEach(() => vi.useRealTimers());

  const bars = (n: number) => Array.from({ length: n }, (_, i) => ({ time: i * 60, open: 1, high: 1, low: 1, close: 1 + i }));
  /** Runs an update of `count` bars that takes `ms` in the worker. */
  async function update(engine: OakEngine, count: number, ms: number): Promise<void> {
    worker.delay = ms;
    const done = engine.update("chart|study", "s1", bars(count));
    await vi.advanceTimersByTimeAsync(ms);
    await done;
  }

  it("notes the time of a run over all the bars against the run limit", async () => {
    const engine = new OakEngine();
    const seen: [string, OakCalculation][] = [];
    engine.onCalculation((id, c) => seen.push([id, c]));
    await update(engine, 10, 4000);
    expect(worker.posted[0].live?.from).toBe(0);
    expect(engine.calculation("s1")).toEqual({ ms: 4000, limitMs: RUN_TIMEOUT_MS });
    expect(seen.map(([id]) => id)).toEqual(["s1"]);
  });

  it("does not count a live update of the newest bars, but counts one that calculates every bar", async () => {
    const engine = new OakEngine();
    await update(engine, 10, 4000);
    await update(engine, 11, 50);
    expect(worker.posted[1].live?.from).toBe(10);
    expect(engine.calculation("s1")?.ms).toBe(4000);
    worker.fullRunReason = "request.security";
    await update(engine, 12, 60);
    expect(engine.calculation("s1")?.ms).toBe(60);
  });
});
