import { describe, expect, it } from "vitest";
import { canonicalPath, isFile } from "../src/pages";

const at = (path: string) => canonicalPath(path.split("/").filter(Boolean));

describe("canonicalPath", () => {
  it("keeps the website's own addresses", () => {
    for (const p of ["/", "/t/AAPL", "/t/BRK.B", "/t/AAPL/about", "/c/general", "/c/general/about", "/p/b7b82f2kg6", "/u/Begood", "/suggestions", "/suggestions/new", "/tickers", "/search", "/contact"]) {
      expect(at(p)).toBe(p);
    }
  });
  it("gives one address per page", () => {
    expect(at("/t/aapl")).toBe("/t/AAPL");
    expect(at("/t/AAPL/")).toBe("/t/AAPL");
    expect(at("/c/suggestions")).toBe("/suggestions");
    expect(at("/c/options")).toBe("/c/general");
    expect(at("/following")).toBe("/");
  });
  it("leaves the API's addresses and unknown ones", () => {
    for (const p of ["/home", "/me", "/feed", "/posts/abc", "/tickers/AAPL", "/suggestions/abc", "/mod/queue", "/auth/start", "/check", "/nonexistent", "/t/$AAPL", "/p/abc/extra"]) {
      expect(at(p)).toBeNull();
    }
  });
});

describe("isFile", () => {
  it("tells the website's files from its pages", () => {
    expect(isFile("/assets/index-DiFMS-cp.js")).toBe(true);
    expect(isFile("/community-auth.html")).toBe(true);
    expect(isFile("/t/BRK.B")).toBe(false);
    expect(isFile("/t/AAPL")).toBe(false);
  });
});
