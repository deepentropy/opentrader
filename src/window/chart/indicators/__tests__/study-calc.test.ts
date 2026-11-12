import { describe, expect, it, vi } from "vitest";
import type { Bar } from "oakscriptjs";

type Point = { time: number; value: number };
type Result = { plots: { sum: Point[] }; markers: { time: number; text: string }[]; total: number };

/** A study (running sum of closes, a marker on the last bar) whose run keeps its arrays and point objects and changes
 *  them in place, as a resumed run may. */
function full(bars: Bar[]): Result {
  let s = 0;
  const sum = bars.map((b) => ({ time: b.time as number, value: (s += b.close) }));
  return { plots: { sum }, markers: bars.length ? [{ time: bars[bars.length - 1]!.time as number, text: `last ${bars[bars.length - 1]!.close}` }] : [], total: s };
}
function createRun() {
  const sum: Point[] = [];
  const markers: { time: number; text: string }[] = [];
  const result: Result = { plots: { sum }, markers, total: 0 };
  let confirmed = 0;
  let base = 0;
  let copy: Bar[] = [];
  return {
    fullRunReason: null,
    update(bars: Bar[]) {
      const same = confirmed > 0 && bars.length > confirmed && copy.slice(0, confirmed).every((b, i) => b.time === bars[i]!.time && b.close === bars[i]!.close);
      const from = same ? confirmed : 0;
      if (!same) { sum.length = 0; base = 0; }
      let s = base;
      for (let i = from; i < bars.length; i++) {
        s += bars[i]!.close;
        if (sum[i]) { sum[i]!.time = bars[i]!.time as number; sum[i]!.value = s; } else sum[i] = { time: bars[i]!.time as number, value: s };
        if (i === bars.length - 2) base = s;
      }
      sum.length = bars.length;
      if (bars.length === 1) base = 0;
      confirmed = bars.length - 1;
      copy = bars.map((b) => ({ ...b }));
      // the marker changes in place
      if (!markers[0]) markers[0] = { time: 0, text: "" };
      markers[0].time = bars[bars.length - 1]!.time as number;
      markers[0].text = `last ${bars[bars.length - 1]!.close}`;
      result.total = s;
      return Object.assign(result, { from });
    },
  };
}

/** The bars each calculation of "seen-sum" was given. */
const seenBars: Bar[][] = vi.hoisted(() => []);

vi.mock("lightweight-charts-indicators/loader", () => {
  const entries = [
    { id: "run-sum", calculate: (bars: Bar[]) => full(bars), createRun },
    { id: "plain-sum", calculate: (bars: Bar[]) => full(bars) },
    { id: "seen-sum", calculate: (bars: Bar[]) => (seenBars.push(bars), full(bars)) },
  ];
  return { setPackedSeries: () => {}, loadIndicator: async (id: string) => entries.find((e) => e.id === id) ?? null };
});

const { calculateStudy } = await import("../study-calc");
const { applyDelta, jobChanges } = await import("../study-worker-types");
const { fromPost } = await import("../packed-points");

/** The window's side of the protocol (as IndicatorLayer.runOffThread): changes only, results rebuilt from deltas. */
function client(entryId: string, study: string) {
  const sent = { stateId: null as number | null, bars: null as Bar[] | null, data: new Map<string, unknown>() };
  let version: number | null = null;
  let raw: unknown = null;
  let id = 0;
  const jobBytes: number[] = [];
  return {
    jobBytes,
    async update(bars: Bar[]): Promise<unknown> {
      for (;;) {
        const changes = jobChanges(sent, bars, {}, (v) => JSON.stringify(v));
        const job = structuredClone({ kind: "study" as const, id: ++id + Math.floor(Math.random() * 1e6) * 100, entryId, study, base: version, restamp: false, inputs: {}, ctx: {}, accessors: [], sources: {}, ...changes });
        jobBytes.push(JSON.stringify(job.bars).length);
        const reply = structuredClone(await calculateStudy(job));
        reply.result = fromPost(reply.result);
        if (reply.retry) { sent.stateId = null; version = null; raw = null; continue; }
        sent.stateId = reply.id;
        if (reply.base != null) reply.result = applyDelta(reply.result, raw);
        version = reply.id;
        raw = reply.result;
        return raw;
      }
    },
  };
}

const bar = (i: number, close: number): Bar => ({ time: 1_700_000_000 + i * 60, open: close, high: close + 1, low: close - 1, close, volume: 100 + i });

describe("study worker: changed bars only, results as full runs", () => {
  for (const id of ["run-sum", "plain-sum"]) {
    it(`${id}: ticks, new bars and a history change give the full result`, async () => {
      const c = client(id, `chart|${id}`);
      const bars = Array.from({ length: 500 }, (_, i) => bar(i, 100 + Math.sin(i / 7) * 5));
      expect(await c.update(bars)).toEqual(full(bars));
      for (let t = 0; t < 30; t++) {
        const last = bars[bars.length - 1]!;
        if (t % 7 === 6) bars.push(bar(bars.length, last.close + 0.5));
        else bars[bars.length - 1] = { ...last, close: last.close + (t % 3) - 1, high: last.high + 1 };
        expect(await c.update(bars)).toEqual(full(bars));
      }
      // live updates sent the forming bar and the new ones only
      expect(Math.max(...c.jobBytes.slice(1))).toBeLessThan(c.jobBytes[0]! / 100);
      // history adjusted: the result is the full one again
      for (let i = 0; i < bars.length; i++) bars[i] = { ...bars[i]!, close: bars[i]!.close * 1.01 };
      expect(await c.update(bars)).toEqual(full(bars));
    });
  }

  it("a worker that does not hold the study's state takes the whole bars again", async () => {
    const bars = Array.from({ length: 50 }, (_, i) => bar(i, 10 + i));
    const a = client("run-sum", "chart|lost");
    await a.update(bars);
    // another window state for the same study (the worker's state is not the one this client sent)
    const b = client("run-sum", "chart|lost");
    await b.update(bars);
    bars[bars.length - 1] = { ...bars[bars.length - 1]!, close: 99 };
    expect(await a.update(bars)).toEqual(full(bars));
  });

  it("the studies on a chart read the same bar objects", async () => {
    const bars = Array.from({ length: 300 }, (_, i) => bar(i, 50 + i));
    const a = client("seen-sum", "chart|shared-a");
    const b = client("seen-sum", "chart|shared-b");
    seenBars.length = 0;
    expect(await a.update(bars)).toEqual(full(bars));
    expect(await b.update(bars)).toEqual(full(bars));
    const [x, y] = seenBars;
    expect(x).not.toBe(y);
    expect(x!.every((q, i) => q === y![i])).toBe(true);
    // a live tick: the forming bar is the new one, the others still shared
    bars[bars.length - 1] = { ...bars[bars.length - 1]!, close: 7 };
    seenBars.length = 0;
    expect(await a.update(bars)).toEqual(full(bars));
    expect(await b.update(bars)).toEqual(full(bars));
    expect(seenBars[1]![299]).toBe(seenBars[0]![299]);
    expect(seenBars[1]![299]!.close).toBe(7);
    expect(seenBars[1]![10]).toBe(x![10]);
    // a study sent other bars reads its own
    const c = client("seen-sum", "chart|shared-c");
    const other = bars.map((q, i) => (i === 5 ? { ...q, close: -1 } : q));
    seenBars.length = 0;
    expect(await c.update(other)).toEqual(full(other));
    expect(seenBars[0]![5]!.close).toBe(-1);
    expect(seenBars[0]![6]).toBe(x![6]);
  });
});
