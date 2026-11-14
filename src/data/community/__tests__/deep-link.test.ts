import { describe, expect, it } from "vitest";
import { linkedPost, postOfLink } from "../deep-link";

describe("opentrader:// links", () => {
  it("reads a post's link", () => {
    expect(linkedPost("opentrader://post/tkjs1al6fa")).toBe("tkjs1al6fa");
    expect(linkedPost("opentrader://post/TKJS1AL6FA/")).toBe("tkjs1al6fa");
    expect(linkedPost("opentrader://p/tkjs1al6fa?from=web")).toBe("tkjs1al6fa");
  });
  it("ignores anything else", () => {
    for (const u of ["https://community.opentrader.markets/p/abc123", "opentrader://chart/NVDA", "opentrader://post/../x", "opentrader://post/"]) expect(linkedPost(u)).toBeNull();
  });
});

describe("links the main menu opens from the clipboard", () => {
  const site = "https://community.opentrader.markets";
  it("reads an app link or a post's page", () => {
    expect(postOfLink("opentrader://post/tkjs1al6fa", site)).toBe("tkjs1al6fa");
    expect(postOfLink(" https://community.opentrader.markets/p/TKJS1AL6FA/?x=1 ", site)).toBe("tkjs1al6fa");
  });
  it("ignores anything else", () => {
    for (const u of ["", "hello", "https://community.opentrader.markets/", "https://community.opentrader.markets/p/", "https://example.com/p/abc123", "https://community.opentrader.markets/p/abc123/extra"])
      expect(postOfLink(u, site)).toBeNull();
  });
});
