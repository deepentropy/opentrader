import { describe, expect, it } from "vitest";
import { baseOf } from "../server-clock";

describe("server clock (#422)", () => {
  it("takes the server's time at the middle of the round trip", () => {
    // Asked at 1000 ms of performance.now(), answered at 1040: the server read 1_800_000_000_000 at about 1020.
    const base = baseOf(1_800_000_000_000, "gateway", 1000, 1040)!;
    expect(base + 1040).toBe(1_800_000_000_020);
    expect(base + 2040).toBe(1_800_000_001_020);
  });

  it("is the computer's clock without a server time", () => {
    expect(baseOf(1_800_000_000_000, null, 0, 10)).toBeNull();
    expect(baseOf(null, "gateway", 0, 10)).toBeNull();
  });
});
