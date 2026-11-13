import { describe, expect, it } from "vitest";
import { formatProfileTime, hotLines, profileRows } from "../rows";

describe("profileRows", () => {
  it("gives shares of the run time and the own-line time of nested code blocks", () => {
    const rows = profileRows({
      total: 1000,
      lines: [
        { lines: [2, 8], invocations: 1, time: 900 },
        { lines: [3, 5], invocations: 10, time: 500 },
        { lines: [4], invocations: 100, time: 300 },
        { lines: [6], invocations: 10, time: 100 },
        { lines: [9], invocations: 1, time: 50 },
      ],
    });
    expect(rows.map((r) => [r.line, r.percent, r.lineTime])).toEqual([
      [2, 90, 300],
      [3, 50, 200],
      [4, 30, undefined],
      [6, 10, undefined],
      [9, 5, undefined],
    ]);
  });

  it("keeps the outer span of two on one line", () => {
    const rows = profileRows({ total: 100, lines: [{ lines: [3, 3 + 1], invocations: 5, time: 40 }, { lines: [3], invocations: 2, time: 10 }] });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ line: 3, end: 4, time: 40 });
  });
});

describe("hotLines", () => {
  it("marks the three slowest rows when there are more than three", () => {
    const rows = profileRows({ total: 100, lines: [1, 2, 3, 4].map((l) => ({ lines: [l] as [number], invocations: 1, time: l * 10 })) });
    expect(hotLines(rows)).toEqual([4, 3, 2]);
    expect(hotLines(rows.slice(0, 3))).toEqual([]);
  });
});

describe("formatProfileTime", () => {
  it("shows µs, ms or s", () => {
    expect(formatProfileTime(120.4)).toBe("120 µs");
    expect(formatProfileTime(67_512)).toBe("67.5 ms");
    expect(formatProfileTime(1_234_567)).toBe("1.2 s");
  });
});
