import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import type { User } from "../src/auth";
import { parseBacktest, putFile, serveFile } from "../src/backtests";

const periods = { full: {}, in: {}, out: {} };
const summary = {
  strategy: { name: "Bands", author: "someone" },
  rules: "LONG when close crosses above lower band",
  interval: "60",
  first: 1, split: 2, last: 3,
  universe: { label: "499 stocks", rule: "most traded", count: 499 },
  inputs: [],
  summary: { default: periods, optimized: periods },
};

describe("a backtest's summary", () => {
  it("is kept as sent when complete", () => {
    expect(JSON.parse(parseBacktest(summary))).toEqual(summary);
  });
  it("is refused when a field the page reads is missing", () => {
    for (const drop of ["strategy", "rules", "interval", "split", "universe", "inputs", "summary"]) {
      const b: Record<string, unknown> = { ...summary };
      delete b[drop];
      expect(() => parseBacktest(b)).toThrow(expect.objectContaining({ status: 400 }));
    }
    expect(() => parseBacktest(null)).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => parseBacktest({ ...summary, rules: "x".repeat(70_000) })).toThrow(expect.objectContaining({ status: 400 }));
  });
});

describe("a backtest's files", () => {
  const owner = { id: "u-owner" } as User;
  const stored = new Map<string, ArrayBuffer>();
  const row = { id: "p1", type: "backtest", author_id: "u-owner", deleted: 0, removed: 0 };
  const env = (r: object | null = row) =>
    ({
      DB: { prepare: () => ({ bind: () => ({ first: async () => r }) }) },
      IMAGES: {
        put: async (k: string, v: ArrayBuffer) => void stored.set(k, v),
        get: async (k: string) => (stored.has(k) ? { body: stored.get(k), httpMetadata: { contentType: "application/json" } } : null),
      },
    }) as unknown as Env;
  const put = (file: string, body = "{}") => new Request(`https://x/bot/backtests/p1/${file}`, { method: "PUT", body });

  it("are stored under the post and served while it is shown", async () => {
    expect((await putFile(env(), owner, put("s/BRK.B.json"), "p1", "s/BRK.B.json")).status).toBe(200);
    expect(stored.has("backtests/p1/s/BRK.B.json")).toBe(true);
    expect((await serveFile(env(), "p1", "s/BRK.B.json")).status).toBe(200);
    await expect(serveFile(env({ ...row, removed: 1 }), "p1", "s/BRK.B.json")).rejects.toMatchObject({ status: 404 });
    await expect(serveFile(env({ ...row, type: "analysis" }), "p1", "s/BRK.B.json")).rejects.toMatchObject({ status: 404 });
  });
  it("only take the known names, from the post's author, on a backtest", async () => {
    for (const file of ["../x.json", "s/aapl.json", "notes.txt", "script.pine", "s/A/B.json"]) {
      await expect(putFile(env(), owner, put(file), "p1", file)).rejects.toMatchObject({ status: 400 });
    }
    await expect(putFile(env(), { id: "u-other" } as User, put("stocks.json"), "p1", "stocks.json")).rejects.toMatchObject({ status: 403 });
    await expect(putFile(env({ ...row, type: "idea" }), owner, put("stocks.json"), "p1", "stocks.json")).rejects.toMatchObject({ status: 403 });
    await expect(putFile(env(), owner, put("stocks.json", ""), "p1", "stocks.json")).rejects.toMatchObject({ status: 413 });
  });
});
