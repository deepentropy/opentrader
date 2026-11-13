import { beforeEach, describe, expect, it, vi } from "vitest";

const replay = vi.hoisted(() => ({ finished: false, calls: [] as string[] }));
vi.mock("../../../data/replay", () => ({
  replayFinished: () => replay.finished,
  forgetSavedReplay: () => replay.calls.push("forget"),
  closeReplay: () => replay.calls.push("close"),
}));
vi.mock("../../../data/trading/trading-ui", () => ({
  tradingUi: { setBrokerPicker: (on: boolean) => replay.calls.push(`picker:${on}`) },
}));

import { leaveReplayForBroker } from "../connect-broker";

describe("leaveReplayForBroker", () => {
  beforeEach(() => {
    replay.finished = false;
    replay.calls = [];
  });

  it("closes a running replay without asking, then opens the broker selection", () => {
    leaveReplayForBroker();
    expect(replay.calls).toEqual(["close", "picker:true"]);
  });

  it("forgets a finished replay first", () => {
    replay.finished = true;
    leaveReplayForBroker();
    expect(replay.calls).toEqual(["forget", "close", "picker:true"]);
  });
});
