import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rules = vi.hoisted(() => ({ enabled: [] as unknown[] }));
const emitAppEvent = vi.hoisted(() => vi.fn());
vi.mock("../../data/alert-store", () => ({ alertStore: { enabledRules: () => rules.enabled } }));
vi.mock("../../data/app-events", () => ({ emitAppEvent }));

class FakeSocket {
  static all: FakeSocket[] = [];
  onopen?: () => void;
  onmessage?: (m: { data: string }) => void;
  onclose?: () => void;
  closed = false;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  open() {
    this.onopen?.();
  }
  close() {
    this.closed = true;
    this.onclose?.();
  }
}

const TEN_MINUTES = 10 * 60_000;
let hidden = false;
let posted: string[] = [];
let page: EventTarget & { hidden?: boolean };

function setHidden(value: boolean) {
  hidden = value;
  page.dispatchEvent(new Event("visibilitychange"));
}

/** Lets the module's dynamic imports and promise chains finish. */
const flush = () => vi.advanceTimersByTimeAsync(50);

async function connectedTab() {
  const server = await import("../server");
  const call = server.call("set_watchlist_subscription", { symbols: ["AAPL"] });
  FakeSocket.all[0].open();
  await call;
  posted = [];
  return server;
}

describe("a tab left in the background", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    FakeSocket.all = [];
    rules.enabled = [];
    hidden = false;
    posted = [];
    emitAppEvent.mockClear();
    page = new EventTarget();
    Object.defineProperty(page, "hidden", { get: () => hidden });
    vi.stubGlobal("document", page);
    vi.stubGlobal("location", { origin: "http://demo.test" });
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        posted.push(String(url).split("/").pop()!);
        return new Response("null", { status: 200 });
      }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keeps its connection for the first ten minutes hidden", async () => {
    await connectedTab();
    setHidden(true);
    await vi.advanceTimersByTimeAsync(TEN_MINUTES - 1000);
    expect(FakeSocket.all[0].closed).toBe(false);
  });

  it("lets go after ten minutes hidden, without reconnecting", async () => {
    await connectedTab();
    setHidden(true);
    await vi.advanceTimersByTimeAsync(TEN_MINUTES + 1000);
    expect(FakeSocket.all[0].closed).toBe(true);
    await vi.advanceTimersByTimeAsync(TEN_MINUTES);
    expect(FakeSocket.all).toHaveLength(1);
  });

  it("stays connected when shown again before the ten minutes", async () => {
    await connectedTab();
    setHidden(true);
    await vi.advanceTimersByTimeAsync(TEN_MINUTES / 2);
    setHidden(false);
    await vi.advanceTimersByTimeAsync(TEN_MINUTES);
    expect(FakeSocket.all[0].closed).toBe(false);
    expect(emitAppEvent).not.toHaveBeenCalled();
  });

  it("back in view: connects, subscribes again and reloads the charts", async () => {
    await connectedTab();
    setHidden(true);
    await vi.advanceTimersByTimeAsync(TEN_MINUTES + 1000);
    setHidden(false);
    expect(FakeSocket.all).toHaveLength(2);
    FakeSocket.all[1].open();
    await flush();
    expect(posted).toEqual(["set_watchlist_subscription"]);
    expect(emitAppEvent).toHaveBeenCalledWith("chart-reload-data");
  });

  it("a subscription asked while paused goes out on return", async () => {
    const server = await connectedTab();
    setHidden(true);
    await vi.advanceTimersByTimeAsync(TEN_MINUTES + 1000);
    const pending = server.call("set_chart_subscription", { pane: "0", symbol: "MSFT" });
    await flush();
    expect(posted).toEqual([]);
    expect(FakeSocket.all).toHaveLength(1);
    setHidden(false);
    FakeSocket.all[1].open();
    await pending;
    await flush();
    expect(posted).toContain("set_chart_subscription");
  });

  it("stays connected while an alert is active, and pauses once none is", async () => {
    rules.enabled = [{ id: "a" }];
    await connectedTab();
    setHidden(true);
    await vi.advanceTimersByTimeAsync(TEN_MINUTES + 1000);
    expect(FakeSocket.all[0].closed).toBe(false);
    rules.enabled = [];
    await vi.advanceTimersByTimeAsync(TEN_MINUTES);
    expect(FakeSocket.all[0].closed).toBe(true);
  });
});
