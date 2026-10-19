/*
 * Connection recovery for data requests. A request that fails because the
 * data server could not be reached (no network yet at app start, a dropped
 * connection, a busy or failing server) is tried again until it gets through,
 * the way the reference app re-requests its series once it is connected again:
 * a chart opened offline fills in by itself when the network comes back
 * instead of staying empty. Other failures (unknown symbol, no data, a bad
 * request) are final and thrown at once.
 *
 * Waits back off from 1 s to 15 s. Any request that gets through, or the
 * browser's `online` event, wakes every waiting request at once.
 */

/** Error codes of a failed request that a later try can get past (the
 *  backend's error text ends with "(<CODE>" + optional ", ref …" + ")"). */
const TRANSIENT_CODE = /\((?:NETWORK|RATE_LIMITED|UPSTREAM_ERROR|UPSTREAM_TIMEOUT|INTERNAL|HTTP 5\d\d)(?:,|\))/;
/** A build without a gateway token reports NETWORK too, but never recovers. */
const NO_TOKEN = /No gateway token/;

const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000];

/** True when `e` is a failure a later try can get past. */
export function isTransientError(e: unknown): boolean {
  const text = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  return TRANSIENT_CODE.test(text) && !NO_TOKEN.test(text);
}

let wakers = new Set<() => void>();

/** Wakes every request waiting to retry (a request got through). */
function reconnected() {
  const all = wakers;
  wakers = new Set();
  for (const w of all) w();
}

// (Test setups may stub `window` without listeners.)
if (typeof window !== "undefined") window.addEventListener?.("online", reconnected);

/** Waits before try `attempt` + 1 of a request that keeps failing (backoff;
 *  woken early when another request gets through). */
export function waitBeforeRetry(attempt: number): Promise<void> {
  return waitRetry(BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]);
}

function waitRetry(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      wakers.delete(done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    wakers.add(done);
  });
}

/** `request()`, tried again after each transient failure until it succeeds.
 *  A final failure is thrown. `wanted()` false stops the retries (the caller
 *  moved on): the last error is thrown. */
export async function retryTransient<T>(request: () => Promise<T>, wanted: () => boolean = () => true): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      const value = await request();
      if (attempt > 0) reconnected();
      return value;
    } catch (e) {
      if (!isTransientError(e) || !wanted()) throw e;
      if (attempt === 0) console.warn("[connection] request failed, retrying until it gets through:", e);
      await waitBeforeRetry(attempt);
      if (!wanted()) throw e;
    }
  }
}

