import { beforeEach, describe, expect, it } from "vitest";
import { clockLine, formatDiagnostics, type Diagnostics } from "../diagnostics";
import { logConsoleError, recentErrors, reportError, resetErrorReports } from "../error-reports";

const base: Diagnostics = {
  app: { version: "0.4.28", buildDate: "2026-11-18", desktop: true },
  system: { os: "Windows 11 Pro 24H2 (26100)", arch: "x86_64", cpu: "Intel i9-13900KF", threads: 32, memoryGb: 68.5, webview: "131.0.2903.112" },
  browser: "Mozilla/5.0",
  window: { width: 1920, height: 1040, scaling: 150, screenWidth: 2560, screenHeight: 1440, zoom: 100 },
  language: "en",
  tabs: { count: 3, layout: "2h", charts: 2 },
  charts: [
    {
      index: 1,
      focused: true,
      symbol: "NASDAQ:AAPL",
      interval: "5",
      chartType: "candles",
      session: "regular",
      source: "built-in data",
      bars: 5000,
      studies: [{ name: "Relative Strength Index", changed: { length: 21 } }, { name: "Pivot Points Standard", changed: {}, hidden: true }],
      drawings: { trend_line: 2, rectangle: 1 },
      compares: ["NASDAQ:MSFT"],
    },
    { index: 2, focused: false, symbol: "MT5:EURUSD", interval: "15", chartType: "line", session: "extended", source: "plugin MT5 0.1.3", bars: null, studies: [], drawings: {}, compares: [] },
  ],
  replay: { on: true, timing: "Select bar", update: "1" },
  plugins: [{ name: "MT5", version: "0.1.3", provides: ["datafeed", "broker"], enabled: true, connected: true }],
  errors: [{ at: new Date(2026, 10, 18, 9, 5, 7).getTime(), kind: "uncaught", text: "TypeError: x is undefined (at run (App.js:1:2))", count: 3 }],
  at: new Date(2026, 10, 18, 9, 6, 0).getTime(),
};

describe("diagnostic info", () => {
  beforeEach(() => resetErrorReports());

  it("gives the version, computer, window, charts, replay, plugins and errors as Markdown", () => {
    expect(formatDiagnostics(base)).toBe(
      [
        "### Diagnostic info",
        "",
        "- App: OpenTrader 0.4.28 (built 18/11/2026), desktop",
        "- System: Windows 11 Pro 24H2 (26100), x86_64, Intel i9-13900KF (32 threads), 68.5 GB RAM, web view 131.0.2903.112",
        "- Window: 1920×1040 at 150% scaling (screen 2560×1440), app zoom 100%, language en",
        "- Tabs: 3 open; this tab: layout 2h, 2 charts",
        "- Chart 1 (focused): NASDAQ:AAPL, 5, candles, regular session, built-in data, 5000 bars loaded, drawings: trend_line ×2, rectangle",
        "  - Compared: NASDAQ:MSFT",
        "  - Studies: Relative Strength Index (length=21); Pivot Points Standard [hidden]",
        "- Chart 2: MT5:EURUSD, 15, line, extended session, plugin MT5 0.1.3, bars not loaded",
        "- Bar Replay: on (start: Select bar, update interval 1)",
        "- Plugins: MT5 0.1.3 (datafeed, broker; connected)",
        "- Recent errors (oldest first):",
        "  - 18/11/2026 09:05:07 uncaught ×3: TypeError: x is undefined (at run (App.js:1:2))",
        "- Taken: 18/11/2026 09:06:00",
      ].join("\n"),
    );
  });

  it("shows the browser and no plugins line on the web version", () => {
    const text = formatDiagnostics({ ...base, app: { version: "0.4.28", desktop: false }, system: null, plugins: [], errors: [], replay: { on: false } });
    expect(text).toContain("- App: OpenTrader 0.4.28, web");
    expect(text).toContain("- Browser: Mozilla/5.0");
    expect(text).toContain("- Bar Replay: off");
    expect(text).toContain("- Recent errors: none");
    expect(text).not.toContain("Plugins");
  });

  it("says how far off the computer's clock is (#422)", () => {
    expect(formatDiagnostics({ ...base, clock: { offsetMs: 3020, source: "gateway" } })).toContain("- Clock: 3.0 s behind the server (gateway)");
    expect(clockLine({ offsetMs: -1500, source: "plugin" })).toBe("1.5 s ahead of the server (plugin)");
    expect(clockLine({ offsetMs: 30, source: "gateway" })).toBe("on time with the server (gateway)");
    expect(clockLine({ offsetMs: 0, source: null })).toBe("no server time, the computer's clock");
  });

  it("keeps the last errors, cleaned, counting repeats, whether statistics run or not", () => {
    // The same error thrown again from the same place.
    const thrown = () => new TypeError(`Unknown symbol "AAPL"`);
    reportError("uncaught", thrown());
    reportError("uncaught", thrown());
    logConsoleError(["[replay] start failed", new Error("no bars")]);
    const log = recentErrors();
    expect(log.map((e) => [e.kind, e.count])).toEqual([["uncaught", 2], ["console", 1]]);
    expect(log[0].text).toMatch(/^TypeError: Unknown symbol "…"/);
    expect(log[1].text).toBe("[replay] start failed Error: no bars");
    for (let i = 0; i < 12; i++) logConsoleError([`error ${i}`]);
    expect(recentErrors()).toHaveLength(10);
    expect(recentErrors()[9].text).toBe("error 11");
  });
});
