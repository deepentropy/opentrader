import { describe, expect, it } from "vitest";
import { linkedPost } from "../deep-link";

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
