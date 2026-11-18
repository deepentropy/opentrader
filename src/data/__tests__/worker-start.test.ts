/** Starting a worker (#362): a script that does not load is started once more with what was posted, then fails. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const reports = vi.hoisted(() => ({ load: [] as unknown[][], crash: [] as unknown[][] }));
vi.mock("../error-reports", () => ({
  reportWorkerLoad: (...a: unknown[]) => void reports.load.push(a),
  reportWorkerError: (...a: unknown[]) => void reports.crash.push(a),
}));
const build = vi.hoisted(() => ({ changed: false }));
vi.mock("../new-build", () => ({ checkNewBuild: async () => build.changed }));

import { RETRY_MS, startWorker } from "../worker-start";

/** Workers made by the code: `loads` false fires the empty error event of a script that did not load. */
class FakeWorker {
  static made: FakeWorker[] = [];
  static loads = true;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  posted: unknown[] = [];
  terminated = false;
  constructor(readonly url: string) {
    FakeWorker.made.push(this);
    if (!FakeWorker.loads) setTimeout(() => this.onerror?.(new Event("error")), 10);
  }
  postMessage(m: unknown) {
    this.posted.push(m);
  }
  terminate() {
    this.terminated = true;
  }
  reply(data: unknown) {
    this.onmessage?.({ data } as MessageEvent);
  }
}

function start() {
  const got = { messages: [] as unknown[], crashes: 0 };
  const w = startWorker("/assets/worker-x.js", "study", { message: (e) => void got.messages.push(e.data), crash: () => void got.crashes++ });
  return { w, got };
}

describe("startWorker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("Worker", FakeWorker);
    vi.stubGlobal("fetch", async () => { throw new TypeError("Failed to fetch"); });
    FakeWorker.made = [];
    FakeWorker.loads = true;
    build.changed = false;
    reports.load = [];
    reports.crash = [];
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("starts the script again with the messages posted to the first try", async () => {
    FakeWorker.loads = false;
    const { w, got } = start();
    w.postMessage({ id: 1 });
    FakeWorker.loads = true;
    await vi.advanceTimersByTimeAsync(10);
    w.postMessage({ id: 2 });
    expect(FakeWorker.made).toHaveLength(1);
    expect(reports.load).toEqual([["study", "/assets/worker-x.js", "network", 1]]);
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    expect(FakeWorker.made).toHaveLength(2);
    expect(FakeWorker.made[1].posted).toEqual([{ id: 1 }, { id: 2 }]);
    FakeWorker.made[1].reply({ id: 1 });
    expect(got).toEqual({ messages: [{ id: 1 }], crashes: 0 });
    expect(reports.load[reports.load.length - 1]).toEqual(["study", "/assets/worker-x.js", "started again", 2]);
  });

  it("fails after the second try", async () => {
    FakeWorker.loads = false;
    const { got } = start();
    await vi.advanceTimersByTimeAsync(10 + RETRY_MS + 10);
    expect(FakeWorker.made).toHaveLength(2);
    expect(got.crashes).toBe(1);
    await vi.advanceTimersByTimeAsync(RETRY_MS * 2);
    expect(FakeWorker.made).toHaveLength(2);
  });

  it("does not start again when a new build removed the script", async () => {
    FakeWorker.loads = false;
    build.changed = true;
    const { got } = start();
    await vi.advanceTimersByTimeAsync(10 + RETRY_MS);
    expect(FakeWorker.made).toHaveLength(1);
    expect(got.crashes).toBe(1);
    expect(reports.load).toEqual([["study", "/assets/worker-x.js", "new build", 1]]);
  });

  it("reports a crash as a crash, without starting again", async () => {
    const { got } = start();
    FakeWorker.made[0].reply("ready");
    const crash = Object.assign(new Event("error"), { message: "Uncaught TypeError: x is not a function" });
    FakeWorker.made[0].onerror?.(crash);
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    expect(FakeWorker.made).toHaveLength(1);
    expect(got.crashes).toBe(1);
    expect(reports.crash).toHaveLength(1);
    expect(reports.load).toHaveLength(0);
  });

  it("ends quietly when terminated while waiting to start again", async () => {
    FakeWorker.loads = false;
    const { w, got } = start();
    await vi.advanceTimersByTimeAsync(10);
    w.terminate();
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    expect(FakeWorker.made).toHaveLength(1);
    expect(got.crashes).toBe(0);
  });
});
