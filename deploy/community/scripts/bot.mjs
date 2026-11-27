/*
 * The project's replies and posts from the command line (the posting API, src/bot-api.ts), written as the account
 * AUTHOR names (deploy/community/.dev.vars.bot), or `--as <name>`; `--as bot` writes as OpenTrader-bot.
 *
 *   node scripts/bot.mjs comment <post id> <text file | ->  [--parent <comment id>]  [--as <name>]
 *   node scripts/bot.mjs post <community: c:general, t:AAPL> "<title>" <text file | ->
 *   node scripts/bot.mjs edit <comment|post> <id> <text file | ->
 *   node scripts/bot.mjs delete <comment|post> <id>
 *   node scripts/bot.mjs backtest <folder> "<title>" [--app strategy:<key>]   a backtest in Backtests, then its files
 *   node scripts/bot.mjs backtest <folder> --post <id> [--app strategy:<key>] replace a backtest's summary and files
 *
 * A backtest's folder: post.json (the summary without the rules), rules.txt, stocks.json, s/<SYMBOL>.json. --app: the
 * app's strategy that runs the script ("Open in OpenTrader").
 *
 * The key is BOT_TOKEN, from the environment or deploy/community/.dev.vars.bot (never in git).
 * COMMUNITY_URL points it at a local server.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

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

const send = async (method, path, body, raw) => {
  const res = await fetch(url + path, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": raw ? "application/octet-stream" : "application/json" },
    body: raw ?? (body && JSON.stringify(body)),
  });
  const answer = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`${method} ${path}: ${res.status} ${answer.error ?? ""}`);
    process.exit(1);
  }
  return answer;
};

if (command === "backtest") {
  if (!token) {
    console.error("No BOT_TOKEN.");
    process.exit(2);
  }
  const [dir, ...rest] = args;
  const flag = (name) => (rest.includes(name) ? rest.splice(rest.indexOf(name), 2)[1] : null);
  const postId = flag("--post");
  const appStudy = flag("--app");
  const title = postId ? null : rest[0];
  if (!dir || (!postId && !title)) usage();
  const p = JSON.parse(readFileSync(join(dir, "post.json"), "utf8"));
  const backtest = {
    strategy: { name: p.name, author: p.author },
    rules: readFileSync(join(dir, "rules.txt"), "utf8").trim(),
    interval: p.interval, first: p.first, split: p.split, last: p.last,
    universe: p.universe, costs: p.costs, inputs: p.inputs, selection: p.selection, summary: p.summary,
    app_study: appStudy,
  };
  // The text: what lists, search and the app's panel show; the page draws the rest from the summary.
  const day = (t) => new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(t * 1000));
  const pct = (v) => (v == null ? "—" : `${v < 0 ? "−" : "+"}${Math.abs(v * 100).toFixed(2)}%`);
  const out = p.summary.default.out;
  const body = [
    "```",
    backtest.rules,
    "```",
    `${p.universe.label}, ${day(p.first)} to ${day(p.last)}; out-of-sample after ${day(p.split)}.`,
    `Median stock out-of-sample with the author's settings: average trade ${pct(out.avg_trade)}, ${Math.round(out.profitable * 100)}% of ${out.stocks} stocks with a profit.`,
  ].join("\n");
  let id = postId;
  if (id) await send("PATCH", `/bot/posts/${id}`, { backtest, as });
  else id = (await send("POST", "/bot/communities/c%3Abacktests/posts", { type: "backtest", title, body, backtest, as })).post.id;
  const files = ["stocks.json", ...readdirSync(join(dir, "s")).filter((f) => f.endsWith(".json")).map((f) => `s/${f}`)];
  let done = 0;
  const q = `${as ? `?as=${encodeURIComponent(as)}` : ""}`;
  const next = async () => {
    for (let f; (f = files.shift()); ) {
      await send("PUT", `/bot/backtests/${id}/${f}${q}`, null, readFileSync(join(dir, f)));
      if (++done % 50 === 0) console.error(`${done} files`);
    }
  };
  await Promise.all(Array.from({ length: 8 }, next));
  console.log(`${id} ${url}/p/${id} (${done} files)`);
  process.exit(0);
}

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
