import { beforeEach, describe, expect, it } from "vitest";
import { cleanText, reportError, reportWorkerError, reportWorkerLoad, resetErrorReports, startErrorReports } from "../error-reports";

type Sent = { event: string; props: Record<string, string | number> };

function collect(): Sent[] {
  const sent: Sent[] = [];
  startErrorReports((event, props) => sent.push({ event, props }));
  return sent;
}

describe("error reports", () => {
  beforeEach(() => resetErrorReports());

  it("removes quoted text, e-mail addresses, folders and address paths", () => {
    expect(cleanText(`Unknown symbol "AAPL" in 'My list'`)).toBe(`Unknown symbol "…" in '…'`);
    expect(cleanText("mail me@example.com")).toBe("mail …@…");
    expect(cleanText("cannot open C:\\Users\\jane\\AppData\\layouts.json")).toBe("cannot open …/layouts.json");
    expect(cleanText("cannot open /home/jane/.config/ot/layouts.json")).toBe("cannot open …/layouts.json");
    expect(cleanText("GET https://api.example.com/market/v1/bars/AAPL?token=abc failed")).toBe("GET api.example.com/… failed");
    expect(cleanText("at run (http://tauri.localhost/assets/App-x1y2.js:12:345)")).toBe("at run (App-x1y2.js:12:345)");
  });

  it("waits for the statistics, then sends each distinct error once", () => {
    // The same error thrown again from the same place.
    const thrown = () => new TypeError("x is undefined");
    reportError("uncaught", thrown());
    const sent = collect();
    expect(sent).toHaveLength(1);
    expect(sent[0].event).toBe("app_error");
    expect(sent[0].props).toMatchObject({ kind: "uncaught", name: "TypeError", message: "x is undefined" });
    reportError("uncaught", thrown());
    expect(sent).toHaveLength(1);
    reportError("rejection", "load failed");
    expect(sent[1].props).toMatchObject({ kind: "rejection", name: "string", message: "load failed" });
  });

  it("keeps the stack's first frames as file names and lines", () => {
    const err = new Error("boom");
    err.stack = "Error: boom\n    at a (http://tauri.localhost/assets/App-1.js:1:2)\n    at b (C:\\Users\\jane\\x\\lib.js:3:4)";
    const sent = collect();
    reportError("uncaught", err);
    expect(sent[0].props.stack).toBe("at a (App-1.js:1:2)\nat b (…/lib.js:3:4)");
  });

  it("ignores browser noise and extensions, and stops at the cap", () => {
    const sent = collect();
    reportError("uncaught", "ResizeObserver loop completed with undelivered notifications.");
    reportError("uncaught", new Error("ext"), { source: "chrome-extension://abc/content.js" });
    expect(sent).toHaveLength(0);
    for (let i = 0; i < 30; i++) reportError("uncaught", new Error(`e${i}`));
    expect(sent).toHaveLength(20);
  });

  it("reports a crashed worker with where it ran", () => {
    const sent = collect();
    reportWorkerError("backtest", { message: "Uncaught RangeError: Maximum call stack size exceeded", filename: "http://tauri.localhost/assets/worker-9.js", lineno: 7, colno: 9 } as unknown as Event);
    expect(sent[0].props).toMatchObject({ kind: "worker", where: "backtest", source: "worker-9.js", line: 7, column: 9 });
  });

  it("reports an empty worker error event as a worker that did not start (#362)", () => {
    const sent = collect();
    reportWorkerError("study", new Event("error"));
    expect(sent[0].props).toMatchObject({ kind: "worker_load", name: "WorkerLoadError", message: "worker failed to start (unknown)", where: "study" });
  });

  it("names the script of a worker that did not start, and each attempt once", () => {
    const sent = collect();
    reportWorkerLoad("study", "https://demo.example.com/assets/worker-tK41tuzE.js", "network", 1);
    reportWorkerLoad("study", "https://demo.example.com/assets/worker-tK41tuzE.js", "network", 1);
    reportWorkerLoad("study", "https://demo.example.com/assets/worker-tK41tuzE.js", "network", 2);
    expect(sent).toHaveLength(2);
    expect(sent[0].props).toMatchObject({ kind: "worker_load", message: "worker failed to start (network)", source: "worker-tK41tuzE.js", attempt: 1 });
    expect(sent[1].props.attempt).toBe(2);
  });
});
