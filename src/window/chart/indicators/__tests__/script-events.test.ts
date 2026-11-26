import { describe, expect, it } from "vitest";
import { scriptEvents } from "../script-events";
import type { ChartEvent } from "../../../../data/datafeed";

const at = (iso: string) => Date.parse(iso);
/** Local midnight of a New York day (as getEvents stamps the events), UNIX s. */
const ny = (day: string) => Date.parse(`${day}T04:00Z`) / 1000;

describe("scriptEvents (#414)", () => {
  it("dividends and splits at 00:00 UTC of their day, earnings by their session, EPS adjusted for later splits", () => {
    const list: ChartEvent[] = [
      { time: ny("2024-03-05"), kind: "dividend", label: "0.04", amount: 0.04, payDate: ny("2024-03-27") },
      { time: ny("2024-05-22"), kind: "earnings", label: "Q1 '25", session: "amc", eps: 5.98 },
      { time: ny("2024-06-10"), kind: "split", label: "10:1", from: 1, to: 10 },
      { time: ny("2024-08-28"), kind: "earnings", label: "Q2 '25", session: "bmo", eps: 0.67 },
      { time: ny("2024-11-20"), kind: "earnings", label: "Q3 '25", session: null, eps: null },
    ];
    const e = scriptEvents(list);
    expect(e.dividends).toEqual([{ time: at("2024-03-05"), net: 0.04, gross: 0.04, payDate: at("2024-03-27") }]);
    expect(e.splits).toEqual([{ time: at("2024-06-10"), numerator: 10, denominator: 1 }]);
    expect(e.earnings).toEqual([
      // after the close: the end of the UTC day (an intraday chart shows it from the next session)
      { time: at("2024-05-23") - 1, actual: 5.98 / 10 },
      { time: at("2024-08-28"), actual: 0.67 },
      { time: at("2024-11-21") - 1, actual: null },
    ]);
    expect(scriptEvents(list)).toBe(e);
  });

  it("an exchange east of UTC: local midnight the evening before is the same calendar day", () => {
    const kolkata = Date.parse("2024-08-18T18:30Z") / 1000;
    expect(scriptEvents([{ time: kolkata, kind: "dividend", label: "10", amount: 10 }]).dividends?.[0]?.time).toBe(at("2024-08-19"));
  });
});
