import { describe, expect, it } from "vitest";
import { day, fmtR, ideaState, postState, recordLine, recordLong } from "../format";
import type { Idea, Post } from "../api";

const idea = (over: Partial<Idea>): Idea => ({
  direction: "long", entry: 148.2, stop: 141, target: 165, expires: "2026-12-15", entry_rule: "close", ref_price: 146, reward_risk: 2.33,
  status: "open", triggered_at: 1, trigger_price: 148.64, resolved_at: null, exit_price: null, last_price: 151.3, result_r: 0.43, ...over,
});

describe("community format", () => {
  it("writes R multiples", () => {
    expect(fmtR(0.44)).toBe("+0.44R");
    expect(fmtR(0.3)).toBe("+0.3R");
    expect(fmtR(-1)).toBe("−1.0R");
    expect(fmtR(14.3)).toBe("+14.3R");
    expect(fmtR(null)).toBe("—");
  });
  it("writes dates dd/mm/yyyy", () => {
    expect(day("2026-12-15")).toBe("15/12/2026");
  });
  it("reads an idea's state", () => {
    expect(ideaState(idea({})).text).toBe("Open · +0.43R");
    expect(ideaState(idea({ status: "target", result_r: 2.1 })).text).toBe("Target hit · +2.1R");
    expect(ideaState(idea({ status: "pending", result_r: null })).text).toBe("Not triggered");
  });
  it("reads a record", () => {
    expect(recordLine({ resolved: 34, hit_pct: 62, avg_r: 0.42, open: 3 })).toBe("34 ideas · 62% hit");
    expect(recordLong({ resolved: 34, hit_pct: 62, avg_r: 0.42, open: 3 })).toBe("34 resolved ideas · 62% hit · +0.42R avg");
    expect(recordLine(null)).toBe("no ideas yet");
  });
  it("gives questions and post-mortems a status", () => {
    const base = { idea: null, type: "question", answer_id: "c1", linked: null } as unknown as Post;
    expect(postState(base)?.text).toBe("Answered");
    expect(postState({ ...base, type: "postmortem", answer_id: null, linked: { id: "x", title: null, status: "stopped", result_r: -1 } })?.text).toBe("Linked idea: stopped · −1.0R");
  });
});
