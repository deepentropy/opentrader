import { afterEach, describe, expect, it, vi } from "vitest";
import { isTransientError, retryTransient } from "../connection";

describe("isTransientError", () => {
  it("retries what a later try can get past", () => {
    expect(isTransientError(new Error("bars: request failed: error sending request (NETWORK)"))).toBe(true);
    expect(isTransientError("ticker info: busy (RATE_LIMITED, ref abc)")).toBe(true);
    expect(isTransientError("bars: upstream (UPSTREAM_TIMEOUT)")).toBe(true);
    expect(isTransientError("bars: bad gateway (HTTP 503)")).toBe(true);
    expect(isTransientError("bars: oops (INTERNAL, ref x1)")).toBe(true);
  });
  it("does not retry final failures", () => {
    expect(isTransientError("bars: unknown ticker (NOT_FOUND)")).toBe(false);
    expect(isTransientError("bars: plan (NOT_ENTITLED)")).toBe(false);
    expect(isTransientError(new Error("unsupported resolution: 7T"))).toBe(false);
    expect(isTransientError("bars: No gateway token in this build — rebuild with OPENTRADER_GATEWAY_TOKEN set (NETWORK)")).toBe(false);
    expect(isTransientError(undefined)).toBe(false);
  });
});

describe("retryTransient", () => {
  afterEach(() => vi.useRealTimers());

  it("tries again after network failures until the request gets through", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const p = retryTransient(async () => {
      calls++;
      if (calls < 3) throw new Error("bars: request failed (NETWORK)");
      return "bars";
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(2000);
    await expect(p).resolves.toBe("bars");
    expect(calls).toBe(3);
  });

  it("throws a final failure at once", async () => {
    let calls = 0;
    await expect(retryTransient(async () => { calls++; throw new Error("bars: x (NOT_FOUND)"); })).rejects.toThrow("NOT_FOUND");
    expect(calls).toBe(1);
  });

  it("stops when the caller no longer wants the result", async () => {
    vi.useFakeTimers();
    let wanted = true;
    let calls = 0;
    const p = retryTransient(async () => { calls++; throw new Error("bars: x (NETWORK)"); }, () => wanted);
    const settled = expect(p).rejects.toThrow("NETWORK");
    await vi.advanceTimersByTimeAsync(1000);
    wanted = false;
    await vi.advanceTimersByTimeAsync(2000);
    await settled;
    expect(calls).toBe(2);
  });

  it("a request that gets through wakes the other waiting requests", async () => {
    vi.useFakeTimers();
    let up = false;
    let slowCalls = 0;
    const slow = retryTransient(async () => { slowCalls++; if (!up) throw new Error("a (NETWORK)"); return "a"; });
    // Back off to the 8 s step on the first request.
    await vi.advanceTimersByTimeAsync(1000 + 2000 + 4000);
    expect(slowCalls).toBe(4);
    let fastCalls = 0;
    const fast = retryTransient(async () => { fastCalls++; if (fastCalls === 1) throw new Error("b (NETWORK)"); return "b"; });
    up = true;
    await vi.advanceTimersByTimeAsync(1000);
    await expect(fast).resolves.toBe("b");
    // Woken by the other request well before its own 8 s wait ends.
    await expect(slow).resolves.toBe("a");
    expect(slowCalls).toBe(5);
  });
});
