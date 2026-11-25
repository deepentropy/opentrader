/*
 * OpenTrader-bot from the command line (the bot API, src/bot-api.ts). Facts only: it is a labelled account.
 *
 *   node scripts/bot.mjs comment <post id> <text file | ->  [--parent <comment id>]
 *   node scripts/bot.mjs post <community: c:general, t:AAPL> "<title>" <text file | ->
 *   node scripts/bot.mjs edit <comment|post> <id> <text file | ->
 *   node scripts/bot.mjs delete <comment|post> <id>
 *
 * The key is BOT_TOKEN, from the environment or deploy/community/.dev.vars.bot (never in git).
 * COMMUNITY_URL points it at a local server.
 */
import { existsSync, readFileSync } from "node:fs";

const url = (process.env.COMMUNITY_URL ?? "https://community.opentrader.markets").replace(/\/+$/, "");
const vars = new URL("../.dev.vars.bot", import.meta.url);
const token = process.env.BOT_TOKEN ?? (existsSync(vars) ? /^BOT_TOKEN=(\S+)$/m.exec(readFileSync(vars, "utf8"))?.[1] : undefined);
const [command, ...args] = process.argv.slice(2);
const text = (f) => readFileSync(f === "-" ? 0 : f, "utf8").trim();

const usage = () => {
  console.error("bot.mjs comment <post> <file|-> [--parent <comment>] | post <community> <title> <file|-> | edit <comment|post> <id> <file|-> | delete <comment|post> <id>");
  process.exit(2);
};
const kind = (k) => (k === "comment" || k === "post" ? `${k}s` : usage());

let request;
if (command === "comment" && args.length >= 2) {
  const at = args.indexOf("--parent");
  request = ["POST", `/bot/posts/${args[0]}/comments`, { body: text(args[1]), parent_id: at > 0 ? args[at + 1] : undefined }];
} else if (command === "post" && args.length === 3) request = ["POST", `/bot/communities/${encodeURIComponent(args[0])}/posts`, { title: args[1], body: text(args[2]) }];
else if (command === "edit" && args.length === 3) request = ["PATCH", `/bot/${kind(args[0])}/${args[1]}`, { body: text(args[2]) }];
else if (command === "delete" && args.length === 2) request = ["DELETE", `/bot/${kind(args[0])}/${args[1]}`];
else usage();
if (!token) {
  console.error("No BOT_TOKEN.");
  process.exit(2);
}

const [method, path, body] = request;
const res = await fetch(url + path, {
  method,
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: body && JSON.stringify(body),
});
const answer = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error(`${res.status} ${answer.error ?? ""}`);
  process.exit(1);
}
const made = answer.comment ?? answer.post;
console.log(made ? `${made.id}${answer.post ? ` ${url}/p/${made.id}` : ""}` : "ok");
