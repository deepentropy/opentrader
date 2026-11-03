import { describe, expect, it } from "vitest";
import { barDay, nyTime, openingState, parseIdea, recordLine, recordOf, rewardRisk, rMultiple, sessionClose, stepIdea, type DayBar, type IdeaState } from "../src/ideas";

// Monday 03/11/2025, 12:10 New York (EST, UTC-5).
const POSTED = Date.parse("2025-11-03T17:10:00Z") / 1000;

function idea(over: Partial<IdeaState> = {}): IdeaState {
  return {
    direction: "long", entry: 148.2, stop: 141, target: 165, expires: "2025-12-15", entry_rule: "close",
    ref_price: 146, created_at: POSTED, status: "pending", triggered_at: null, trigger_price: null,
    resolved_at: null, exit_price: null, result_r: null, checked_day: null, ...over,
  };
}
const bar = (day: string, o: number, h: number, l: number, c: number): DayBar => ({ day, o, h, l, c });

describe("ideas", () => {
  it("reads New York dates and sessions", () => {
    expect(nyTime(POSTED)).toEqual({ day: "2025-11-03", hour: 12 });
    // A daily bar starts at midnight New York (05:00 UTC in winter).
    expect(barDay(Date.parse("2025-11-03T05:00:00Z"))).toBe("2025-11-03");
    expect(new Date(sessionClose("2025-11-03") * 1000).toISOString()).toBe("2025-11-03T21:00:00.000Z");
    expect(new Date(sessionClose("2025-07-01") * 1000).toISOString()).toBe("2025-07-01T20:00:00.000Z");
  });

  it("computes R and reward:risk", () => {
    expect(rMultiple("long", 148.2, 141, 151.3)).toBeCloseTo(0.43, 2);
    expect(rMultiple("short", 153.8, 159, 140)).toBeCloseTo(2.65, 2);
    expect(rewardRisk({ entry: 148.2, stop: 141, target: 165 })).toBe(2.33);
  });

  it("checks the levels", () => {
    const at = POSTED;
    expect(parseIdea({ direction: "long", entry: "148.20", stop: "141", target: "165", expires: "2025-12-15" }, 146, at)).toMatchObject({ entry: 148.2, entry_rule: "close" });
    expect(() => parseIdea({ direction: "long", entry: 148, stop: 150, target: 165, expires: "2025-12-15" }, 146, at)).toThrow(/stop below/);
    expect(() => parseIdea({ direction: "short", entry: 148, stop: 141, target: 165, expires: "2025-12-15" }, 146, at)).toThrow(/stop above/);
    expect(() => parseIdea({ direction: "long", entry: 148, stop: 141, target: 400, expires: "2025-12-15" }, 146, at)).toThrow(/within/);
    expect(() => parseIdea({ direction: "long", entry: 148, stop: 141, target: 165, expires: "2025-11-03" }, 146, at)).toThrow(/after today/);
    expect(() => parseIdea({ direction: "long", entry: 148, stop: 141, target: 165, expires: "2027-12-15" }, 146, at)).toThrow(/within a year/);
  });

  it("opens at once at the price", () => {
    expect(openingState({ direction: "long", entry: 146.1, stop: 141, target: 165, expires: "2025-12-15", entry_rule: "close" }, 146, POSTED).status).toBe("open");
    expect(openingState({ direction: "long", entry: 148.2, stop: 141, target: 165, expires: "2025-12-15", entry_rule: "close" }, 146, POSTED).status).toBe("pending");
  });

  it("triggers on the posting day's close, then settles at the target", () => {
    const s = stepIdea(idea(), [bar("2025-11-03", 146, 149, 145.5, 148.64), bar("2025-11-04", 148.6, 152, 147, 151.3), bar("2025-11-05", 151, 166, 150, 164)], "2025-11-05");
    expect(s.status).toBe("target");
    expect(s.trigger_price).toBe(148.64);
    expect(s.triggered_at).toBe(sessionClose("2025-11-03"));
    expect(s.result_r).toBe(2.33);
    expect(s.checked_day).toBe("2025-11-05");
  });

  it("needs a close through the entry, not a poke", () => {
    const s = stepIdea(idea(), [bar("2025-11-04", 146, 149, 145, 147.9)], "2025-11-04");
    expect(s.status).toBe("pending");
    expect(s.checked_day).toBe("2025-11-04");
  });

  it("a trade-through entry starts the next session", () => {
    const s = stepIdea(idea({ entry_rule: "touch" }), [bar("2025-11-03", 146, 149, 140, 147), bar("2025-11-04", 147, 148.5, 146, 148)], "2025-11-04");
    expect(s.status).toBe("open");
    expect(s.trigger_price).toBe(148.2);
    expect(s.triggered_at).toBe(sessionClose("2025-11-04"));
  });

  it("counts a bar reaching both levels as stopped, and a gap past the stop at the open", () => {
    const open = idea({ status: "open", triggered_at: POSTED, trigger_price: 148.2, checked_day: "2025-11-03" });
    expect(stepIdea(open, [bar("2025-11-04", 148, 166, 140, 150)], "2025-11-04")).toMatchObject({ status: "stopped", result_r: -1 });
    expect(stepIdea(open, [bar("2025-11-04", 137.4, 139, 135, 138)], "2025-11-04")).toMatchObject({ status: "stopped", exit_price: 137.4, result_r: -1.5 });
  });

  it("settles a short at its target", () => {
    const short = idea({ direction: "short", entry: 153.8, stop: 159, target: 140, ref_price: 155, status: "open", triggered_at: POSTED, trigger_price: 153.8, checked_day: "2025-11-03" });
    expect(stepIdea(short, [bar("2025-11-04", 150, 152, 139, 141)], "2025-11-04")).toMatchObject({ status: "target", result_r: 2.65 });
  });

  it("expires at the last day's close, or untriggered", () => {
    const open = idea({ status: "open", triggered_at: POSTED, trigger_price: 148.2, checked_day: "2025-12-12", expires: "2025-12-15" });
    expect(stepIdea(open, [bar("2025-12-15", 150, 151, 149, 150.36)], "2025-12-15")).toMatchObject({ status: "expired", result_r: 0.3 });
    expect(stepIdea(idea({ checked_day: "2025-12-12" }), [bar("2025-12-15", 146, 147, 145, 146)], "2025-12-15")).toMatchObject({ status: "untriggered", result_r: null });
  });

  it("ends an idea a week past its last day without sessions", () => {
    expect(stepIdea(idea({ expires: "2025-12-15" }), [], "2025-12-30").status).toBe("untriggered");
  });

  it("sums a record", () => {
    const r = recordOf({ resolved: 34, hits: 21, total_r: 14.3, open: 3 });
    expect(r).toMatchObject({ hit_pct: 62, avg_r: 0.42 });
    expect(recordLine(r)).toBe("34 ideas · 62% hit");
    expect(recordLine(recordOf({ resolved: 0, open: 2 }))).toBe("2 open ideas");
    expect(recordLine(undefined)).toBe("no ideas yet");
  });
});
