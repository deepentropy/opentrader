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
