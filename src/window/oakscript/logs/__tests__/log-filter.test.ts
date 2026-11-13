/**
 * The Logs panel's filters (#323, #325): levels, search text and the start date picked in the chart's time zone.
 */
import { describe, expect, it } from "vitest";
import type { LogEntry } from "oakscriptjs/script";
import { filterLogs, startDateNow, startDateSeconds } from "../log-filter";

const ALL = { info: true, warning: true, error: true };
const log = (time: number, level: LogEntry["level"], message: string): LogEntry => ({ time, level, message }) as LogEntry;
const logs = [log(100, "info", "first close"), log(200, "warning", "Bar 500"), log(300, "error", "bar 1000"), log(400, "info", "last close")];

describe("filterLogs", () => {
  it("keeps all without filters", () => {
    expect(filterLogs(logs, { levels: ALL, query: "", from: null })).toEqual(logs);
  });

  it("keeps the messages from the start date on, with the levels and the search", () => {
    expect(filterLogs(logs, { levels: ALL, query: "", from: 200 }).map((e) => e.time)).toEqual([200, 300, 400]);
    expect(filterLogs(logs, { levels: { ...ALL, error: false }, query: "", from: 200 }).map((e) => e.time)).toEqual([200, 400]);
    expect(filterLogs(logs, { levels: ALL, query: " BAR ", from: 250 }).map((e) => e.time)).toEqual([300]);
  });
});

describe("start date", () => {
  // 13/11/2026 15:31:42 UTC = 10:31 in New York (UTC-5).
  const now = Date.UTC(2026, 10, 13, 15, 31, 42);

  it("opens on now in the chart's time zone, down to the minute", () => {
    expect(startDateNow(now, "America/New_York")).toEqual({ y: 2026, m: 10, d: 13, minutes: 10 * 60 + 31 });
    expect(startDateNow(now, "UTC")).toEqual({ y: 2026, m: 10, d: 13, minutes: 15 * 60 + 31 });
  });

  it("reads the picked date and time in the chart's time zone", () => {
    expect(startDateSeconds({ y: 2026, m: 10, d: 12 }, 16 * 60 + 33, "America/New_York")).toBe(Date.UTC(2026, 10, 12, 21, 33) / 1000);
    expect(startDateSeconds({ y: 2026, m: 10, d: 12 }, 16 * 60 + 33, "UTC")).toBe(Date.UTC(2026, 10, 12, 16, 33) / 1000);
  });
});
