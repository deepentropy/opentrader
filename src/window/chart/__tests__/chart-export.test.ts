import { describe, expect, it } from "vitest";
import { buildChartCsv, type ChartExportSource } from "../chart-export";

function source(times: number[], timeZone: string, dwm = false): ChartExportSource {
  const close = new Map(times.map((t, i) => [t, 100 + i]));
  return {
    title: () => "LOCAL:TEST, 60",
    shown: () => true,
    active: () => true,
    host: () => undefined,
    timeZone: () => timeZone,
    dwm: () => dwm,
    data: () => ({ times, columns: [{ title: "close", values: close }] }),
  };
}

describe("buildChartCsv", () => {
  it("writes ISO times with the zone's offset on each date", () => {
    // 15/01/2024 and 15/07/2024 12:00 UTC: Paris is +1 in winter, +2 in summer.
    const csv = buildChartCsv(source([1705320000, 1721044800], "Europe/Paris"), "iso");
    expect(csv.split("\n")).toEqual(["time,close", "2024-01-15T13:00:00+01:00,100", "2024-07-15T14:00:00+02:00,101"]);
  });

  it("writes Z in UTC and a date only for day bars", () => {
    expect(buildChartCsv(source([1705320000], "UTC"), "iso").split("\n")[1]).toBe("2024-01-15T12:00:00Z,100");
    expect(buildChartCsv(source([1705320000], "America/New_York", true), "iso").split("\n")[1]).toBe("2024-01-15,100");
  });

  it("builds 100,000 ISO rows fast (#369)", () => {
    const times = Array.from({ length: 100_000 }, (_, i) => 1420070400 + i * 3600);
    const t0 = performance.now();
    const csv = buildChartCsv(source(times, "Europe/Paris"), "iso");
    // About 0.5 s on a desktop, up to 2 s on a shared CI runner; a formatter per row took 6 s on the desktop.
    expect(performance.now() - t0).toBeLessThan(4000);
    expect(csv.split("\n")).toHaveLength(100_001);
  });
});
