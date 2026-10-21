import { describe, expect, it } from "vitest";
import { reviveReplaySession } from "../tabs";

describe("saved replay on a tab", () => {
  it("reads back a saved replay and drops malformed ones", () => {
    const ok = { time: 1781668800, mode: "ActiveChart", charts: [{ uid: "pane-1", symbol: "NASDAQ:INTC", interval: "1D", session: "RTH", trading: { x: 1 } }] };
    expect(reviveReplaySession(ok)).toEqual(ok);
    expect(reviveReplaySession({ ...ok, mode: "Other" })).toBeUndefined();
    expect(reviveReplaySession({ ...ok, charts: [{ uid: 1 }] })).toBeUndefined();
    expect(reviveReplaySession(null)).toBeUndefined();
  });
});
