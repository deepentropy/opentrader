import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { botUser } from "../src/bot-api";

const BOT_TOKEN = "k".repeat(40);
const row = { id: "bot", name: "OpenTrader-bot", role: "bot", created_at: 1, banned_until: null, ban_reason: null };
const env = (over: object = {}) => ({ BOT_TOKEN, DB: { prepare: () => ({ bind: () => ({ first: async () => row }) }) }, ...over }) as unknown as Env;
const ask = (authorization?: string) => new Request("https://x/bot/posts/a/comments", { method: "POST", headers: authorization ? { authorization } : {} });

describe("the bot API's key", () => {
  it("gives the bot's account", async () => {
    expect(await botUser(env(), ask(`Bearer ${BOT_TOKEN}`))).toMatchObject({ id: "bot", role: "bot" });
  });
  it("refuses any other key, and none", async () => {
    for (const header of [undefined, "", "Bearer ", "Bearer wrong", `Bearer ${BOT_TOKEN}x`, BOT_TOKEN, `Basic ${BOT_TOKEN}`]) {
      await expect(botUser(env(), ask(header))).rejects.toMatchObject({ status: 401 });
    }
  });
  it("is off without a key, or with a short one", async () => {
    await expect(botUser(env({ BOT_TOKEN: undefined }), ask("Bearer undefined"))).rejects.toMatchObject({ status: 404 });
    await expect(botUser(env({ BOT_TOKEN: "" }), ask("Bearer "))).rejects.toMatchObject({ status: 404 });
    await expect(botUser(env({ BOT_TOKEN: "short" }), ask("Bearer short"))).rejects.toMatchObject({ status: 404 });
  });
});
