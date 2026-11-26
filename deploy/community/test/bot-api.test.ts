import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { botUser } from "../src/bot-api";

const BOT_TOKEN = "k".repeat(40);
const accounts = [
  { id: "bot", name: "OpenTrader-bot", role: "bot", created_at: 1, banned_until: null, ban_reason: null },
  { id: "u-owner", name: "deepentropy", role: "user", created_at: 1, banned_until: null, ban_reason: null },
  { id: "u-member", name: "member", role: "user", created_at: 1, banned_until: null, ban_reason: null },
];
const DB = { prepare: () => ({ bind: (key: string) => ({ first: async () => accounts.find((a) => a.id === key || a.name.toLowerCase() === key) ?? null }) }) };
const env = (over: object = {}) => ({ BOT_TOKEN, API_AUTHORS: "u-owner", DB, ...over }) as unknown as Env;
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

describe("writing as another account", () => {
  const key = `Bearer ${BOT_TOKEN}`;
  it("writes as an account the server lists, by its name in any case", async () => {
    expect(await botUser(env(), ask(key), "DeepEntropy")).toMatchObject({ id: "u-owner", post_checked: 1 });
  });
  it("refuses any other account, and without the key", async () => {
    await expect(botUser(env(), ask(key), "member")).rejects.toMatchObject({ status: 403 });
    await expect(botUser(env(), ask(key), "nobody")).rejects.toMatchObject({ status: 403 });
    await expect(botUser(env({ API_AUTHORS: undefined }), ask(key), "deepentropy")).rejects.toMatchObject({ status: 403 });
    await expect(botUser(env(), ask("Bearer wrong"), "deepentropy")).rejects.toMatchObject({ status: 401 });
  });
  it("writes as the bot without a name", async () => {
    expect(await botUser(env(), ask(key), "")).toMatchObject({ id: "bot" });
    expect(await botUser(env(), ask(key), null)).toMatchObject({ id: "bot" });
  });
});
