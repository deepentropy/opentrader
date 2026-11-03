import { describe, expect, it } from "vitest";
import { base64url, hotRank, nameFromProfile, parseCommunityId, pkceMatches, sha256, topSince } from "../src/util";

describe("hotRank", () => {
  const t = 1_800_000_000;
  it("ranks a newer post above an older one with the same score", () => {
    expect(hotRank(10, t + 3600)).toBeGreaterThan(hotRank(10, t));
  });
  it("is worth 12.5 hours per tenfold score", () => {
    expect(hotRank(100, t) - hotRank(10, t)).toBeCloseTo(1, 6);
    expect(hotRank(1, t + 45_000) - hotRank(1, t)).toBeCloseTo(1, 6);
  });
  it("sinks negative scores", () => {
    expect(hotRank(-10, t)).toBeLessThan(hotRank(0, t));
  });
});

describe("parseCommunityId", () => {
  it("reads tickers in capitals", () => {
    expect(parseCommunityId("t:aapl")).toEqual({ kind: "ticker", key: "AAPL" });
    expect(parseCommunityId("t:BRK.B")).toEqual({ kind: "ticker", key: "BRK.B" });
  });
  it("reads theme slugs", () => {
    expect(parseCommunityId("c:penny-stocks")).toEqual({ kind: "theme", key: "penny-stocks" });
  });
  it("rejects anything else", () => {
    for (const id of ["AAPL", "t:", "t:$AAPL", "c:Penny", "c:a", "x:abc", "t:" + "A".repeat(20)]) expect(parseCommunityId(id)).toBeNull();
  });
});

describe("nameFromProfile", () => {
  it("keeps allowed characters", () => expect(nameFromProfile("jane-doe_42")).toBe("jane-doe_42"));
  it("replaces spaces and accents", () => expect(nameFromProfile("Zoë Martin")).toBe("Zoe_Martin"));
  it("pads short names and cuts long ones", () => {
    expect(nameFromProfile("A").length).toBeGreaterThanOrEqual(3);
    expect(nameFromProfile("x".repeat(40))).toHaveLength(20);
  });
});

describe("PKCE", () => {
  it("matches the S256 challenge of the verifier", async () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    // RFC 7636, appendix B.
    expect(base64url(await sha256(verifier))).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    expect(await pkceMatches(verifier, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")).toBe(true);
    expect(await pkceMatches("other", "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")).toBe(false);
  });
});

describe("topSince", () => {
  it("bounds the period", () => {
    expect(topSince("day", 1000_000)).toBe(1000_000 - 86_400);
    expect(topSince("all", 1000_000)).toBe(0);
  });
});

describe("contentKey", () => {
  it("ignores case, spacing and punctuation", async () => {
    const { contentKey } = await import("../src/api");
    expect(contentKey("Buy XYZ now!!", "To the  moon.")).toBe(contentKey("buy xyz now", "to the moon"));
    expect(contentKey("Buy XYZ", "")).not.toBe(contentKey("Buy XYZW", ""));
    expect(contentKey("$AAPL up", "")).toBe("$aapl up");
  });
});

describe("pickMoves", () => {
  it("keeps the largest moves each way among traded common stocks", async () => {
    const { pickMoves } = await import("../src/bot");
    const s = (ticker: string, changePct: number | null, v = 5_000_000, c = 10) => ({ ticker, changePct, day: { c, v } });
    const picked = pickMoves([
      s("AAA", 40), s("BBB", 25), s("CCC", 20), s("DDD", 16), s("EEE", 10),
      s("FFF", -30), s("GGG", -18),
      s("WARRW", 90, 5_000_000), s("ABC.U", 80), s("THIN", 70, 1000), s("PENNY", 60, 5_000_000, 0.2), s("NONE", null),
    ]).map((x) => x.ticker);
    expect(picked).toEqual(["AAA", "BBB", "CCC", "FFF", "GGG"]);
  });
  it("finds nothing before the session (no volume)", async () => {
    const { pickMoves } = await import("../src/bot");
    expect(pickMoves([{ ticker: "AAA", changePct: 50, day: { c: 5, v: 0 } }])).toEqual([]);
  });
});
