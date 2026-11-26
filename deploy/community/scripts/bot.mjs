/*
 * The project's replies and posts from the command line (the posting API, src/bot-api.ts), written as the account
 * AUTHOR names (deploy/community/.dev.vars.bot), or `--as <name>`; `--as bot` writes as OpenTrader-bot.
 *
 *   node scripts/bot.mjs comment <post id> <text file | ->  [--parent <comment id>]  [--as <name>]
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
const saved = existsSync(vars) ? readFileSync(vars, "utf8") : "";
const token = process.env.BOT_TOKEN ?? /^BOT_TOKEN=(\S+)$/m.exec(saved)?.[1];
const argv = process.argv.slice(2);
const asAt = argv.indexOf("--as");
const named = asAt >= 0 ? argv.splice(asAt, 2)[1] : process.env.AUTHOR ?? /^AUTHOR=(\S+)$/m.exec(saved)?.[1];
const as = named && named !== "bot" ? named : undefined;
const [command, ...args] = argv;
const text = (f) => readFileSync(f === "-" ? 0 : f, "utf8").trim();

const usage = () => {
  console.error("bot.mjs [--as <name|bot>] comment <post> <file|-> [--parent <comment>] | post <community> <title> <file|-> | edit <comment|post> <id> <file|-> | delete <comment|post> <id>");
  process.exit(2);
};
const kind = (k) => (k === "comment" || k === "post" ? `${k}s` : usage());

let request;
if (command === "comment" && args.length >= 2) {
  const at = args.indexOf("--parent");
  request = ["POST", `/bot/posts/${args[0]}/comments`, { body: text(args[1]), parent_id: at > 0 ? args[at + 1] : undefined, as }];
} else if (command === "post" && args.length === 3) request = ["POST", `/bot/communities/${encodeURIComponent(args[0])}/posts`, { title: args[1], body: text(args[2]), as }];
else if (command === "edit" && args.length === 3) request = ["PATCH", `/bot/${kind(args[0])}/${args[1]}`, { body: text(args[2]), as }];
else if (command === "delete" && args.length === 2) request = ["DELETE", `/bot/${kind(args[0])}/${args[1]}${as ? `?as=${encodeURIComponent(as)}` : ""}`];
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
