/*
 * Starting the app's workers (#362). A worker whose script does not load (a network failure, or on the web a new
 * build that removed this page's files) gets an `error` event with nothing in it, unlike a crash, whose event carries
 * the error. Such a failure is reported apart (kind `worker_load`, with what a check of the script's address found),
 * then:
 * - a new build on the web: the window offers to reload (new-build.ts), a second start would fail the same way;
 * - otherwise the worker starts once more after RETRY_MS, with the messages posted so far, so a short network failure
 *   does not leave the studies empty. A second failure goes to `crash`, as a crash does.
 * A worker counts as started at its first message: until then what is posted is kept for the second start.
 */
import { reportWorkerError, reportWorkerLoad } from "./error-reports";
import { checkNewBuild } from "./new-build";

export const RETRY_MS = 2000;

/** What the callers use of a worker. */
export type AppWorker = { postMessage(message: unknown): void; terminate(): void };

/** A script that did not load, or a crash? A crash's event has its error or message. */
export const isLoadFailure = (ev: Event): boolean => {
  const e = ev as ErrorEvent;
  return e.error == null && !e.message;
};

/** Why the script did not load: a new build, the network, its address answering an error, or it loads now. */
async function loadFailureCause(url: string): Promise<string> {
  if (await checkNewBuild()) return "new build";
  try {
    const res = await fetch(url, { method: "HEAD", cache: "no-store" });
    return res.ok ? "loads now" : `status ${res.status}`;
  } catch {
    return "network";
  }
}

/**
 * Start the worker of `url` (a module worker, a `?worker&url` import). `where` names it in the reports. `crash`: the
 * worker crashed, or did not start after the second try; it is ended already.
 */
export function startWorker(url: string, where: string, on: { message: (e: MessageEvent) => void; crash: (e: Event) => void }): AppWorker {
  let worker: Worker | null = null;
  let started = false;
  let attempt = 0;
  let ended = false;
  const posted: unknown[] = [];

  const spawn = (): void => {
    attempt++;
    const w = new Worker(url, { type: "module" });
    w.onmessage = (e) => {
      if (!started) {
        started = true;
        posted.length = 0;
        if (attempt > 1) reportWorkerLoad(where, url, "started again", attempt);
      }
      on.message(e);
    };
    w.onerror = (e) => {
      if (ended || w !== worker) return;
      w.terminate();
      worker = null;
      if (!started && isLoadFailure(e)) void failedToLoad(e);
      else {
        ended = true;
        reportWorkerError(where, e);
        on.crash(e);
      }
    };
    worker = w;
    for (const m of posted) w.postMessage(m);
  };

  const failedToLoad = async (e: Event): Promise<void> => {
    const cause = await loadFailureCause(url);
    if (ended) return;
    reportWorkerLoad(where, url, cause, attempt);
    if (attempt === 1 && cause !== "new build") {
      setTimeout(() => {
        if (!ended) spawn();
      }, RETRY_MS);
      return;
    }
    ended = true;
    on.crash(e);
  };

  spawn();
  return {
    postMessage(message) {
      if (!started) posted.push(message);
      worker?.postMessage(message);
    },
    terminate() {
      ended = true;
      worker?.terminate();
      worker = null;
    },
  };
}
