#!/usr/bin/env node
/*
 * Test content for the LOCAL database: public posts and comments from a
 * public Reddit archive, mapped to our communities. Never run against the
 * production database: the content belongs to its authors.
 *
 *   node scripts/import-reddit.mjs [--posts 15] [--comments 60] [--days-ago 30]
 *
 * Posts come from a 30-day window ending `--days-ago` days back (scores have
 * settled by then), the best ones by score, then shifted in time so the
 * newest is an hour old. Downloads are cached in .reddit-cache/.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = join(ROOT, ".reddit-cache");
const API = "https://arctic-shift.photon-reddit.com/api";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const POSTS = Number(args.posts ?? 15);
const COMMENTS = Number(args.comments ?? 60);
const DAYS_AGO = Number(args["days-ago"] ?? 30);

/** subreddit → community (with an optional title filter). */
const SOURCES = [
  { sub: "pennystocks", community: "c:penny-stocks" },
  { sub: "options", community: "c:options" },
  { sub: "Daytrading", community: "c:day-trading" },
  { sub: "stocks", community: "c:general" },
  { sub: "stocks", community: "c:earnings", title: "earnings" },
  { sub: "technicalanalysis", community: "c:technical-analysis" },
  { sub: "CryptoCurrency", community: "c:crypto" },
  { sub: "ETFs", community: "c:etfs" },
  { sub: "NVDA_Stock", community: "t:NVDA" },
  { sub: "AMD_Stock", community: "t:AMD" },
  { sub: "teslainvestorsclub", community: "t:TSLA" },
  { sub: "PLTR", community: "t:PLTR" },
  { sub: "AAPL", community: "t:AAPL" },
  { sub: "SoFiStock", community: "t:SOFI" },
];

const SKIP_AUTHORS = new Set(["[deleted]", "AutoModerator"]);
const HOT_EPOCH = 1_700_000_000;
const hotRank = (score, at) =>
  Math.round(((score > 0 ? 1 : score < 0 ? -1 : 0) * Math.log10(Math.max(Math.abs(score), 1)) + (at - HOT_EPOCH) / 45_000) * 1e7) / 1e7;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(path) {
  mkdirSync(CACHE, { recursive: true });
  const file = join(CACHE, path.replace(/[^A-Za-z0-9]+/g, "_").slice(0, 180) + ".json");
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(API + path, { headers: { "user-agent": "OpenTrader-Community-test-import/0.1" } });
    if (res.ok) {
      const data = (await res.json()).data ?? [];
      writeFileSync(file, JSON.stringify(data));
      await sleep(300);
      return data;
    }
    if (attempt >= 3) throw new Error(`${path}: ${res.status}`);
    await sleep(2000 * (attempt + 1));
  }
}

const decode = (s) => String(s ?? "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#x200B;/g, "").replace(/&amp;/g, "&");
const gone = (s) => s === "[deleted]" || s === "[removed]";
const q = (v) => (v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const userName = (author) => author.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 20).padEnd(3, "_");

const day = 86_400;
const before = Math.floor(Date.now() / 1000) - DAYS_AGO * day;
const after = before - 30 * day;

const posts = [];
for (const src of SOURCES) {
  // A title search is slower on the archive's side: fewer results, no sort.
  const query = src.title ? `&title=${encodeURIComponent(src.title)}&limit=50` : "&limit=100&sort=desc";
  let found;
  try {
    found = await get(`/posts/search?subreddit=${src.sub}&after=${after}&before=${before}${query}`);
  } catch (e) {
    console.warn(`r/${src.sub}: skipped (${e.message})`);
    continue;
  }
  const picked = found
    .filter((p) => !p.stickied && !p.over_18 && !SKIP_AUTHORS.has(p.author) && !p.removed_by_category && !gone(p.selftext) && (p.selftext || p.url))
    .sort((a, b) => b.score - a.score)
    .slice(0, POSTS);
  for (const p of picked) posts.push({ ...p, community: src.community });
  console.log(`r/${src.sub}${src.title ? ` (${src.title})` : ""} → ${src.community}: ${picked.length} posts`);
}

// A post in two sources (r/stocks and its earnings slice) goes to the narrower one.
const byId = new Map();
for (const p of posts) byId.set(p.id, p);
const unique = [...byId.values()];

const latest = Math.max(...unique.map((p) => p.created_utc));
const nowSec = Math.floor(Date.now() / 1000);
const shift = nowSec - 3600 - latest;

const users = new Map();
const sql = [];
const addUser = (author) => {
  if (!users.has(author)) users.set(author, `imp_${userName(author).toLowerCase()}`);
  return users.get(author);
};

const communities = new Set(unique.map((p) => p.community));
for (const id of communities) {
  if (id.startsWith("t:")) sql.push(`INSERT OR IGNORE INTO communities (id, kind, title, created_at) VALUES (${q(id)}, 'ticker', ${q("$" + id.slice(2))}, unixepoch());`);
}

let commentTotal = 0;
for (const p of unique) {
  const author = addUser(p.author);
  const at = p.created_utc + shift;
  const body = decode(p.selftext) || (p.url && !p.is_self ? p.url : "");
  const comments = (await get(`/comments/search?link_id=${p.id}&limit=100`))
    .filter((c) => c.parent_id && c.author !== "AutoModerator")
    .sort((a, b) => b.score - a.score)
    .slice(0, COMMENTS)
    .sort((a, b) => a.created_utc - b.created_utc);
  const kept = new Set();
  const rows = [];
  for (const c of comments) {
    const parent = c.parent_id.startsWith("t1_") ? c.parent_id.slice(3) : null;
    // A reply whose parent wasn't picked: dropped with its subtree.
    if (parent && !kept.has(parent)) continue;
    kept.add(c.id);
    const deleted = gone(c.body) || c.author === "[deleted]";
    const cAuthor = c.author === "[deleted]" ? null : addUser(c.author);
    rows.push(
      `INSERT OR REPLACE INTO comments (id, post_id, parent_id, author_id, body, score, created_at, deleted) VALUES (${q(c.id)}, ${q(p.id)}, ${q(parent)}, ${q(cAuthor)}, ${q(deleted ? "" : decode(c.body))}, ${c.score ?? 1}, ${Math.min(Math.max(c.created_utc + shift, at), nowSec)}, ${deleted ? 1 : 0});`,
    );
  }
  commentTotal += rows.length;
  sql.push(
    `INSERT OR REPLACE INTO posts (id, community_id, author_id, title, body, score, comment_count, hot, created_at, source_url) VALUES (${q(p.id)}, ${q(p.community)}, ${q(author)}, ${q(decode(p.title).slice(0, 300))}, ${q(body.slice(0, 20_000))}, ${p.score}, ${rows.length}, ${hotRank(p.score, at)}, ${at}, ${q("https://www.reddit.com" + p.permalink)});`,
    ...rows,
  );
}

// Users first (the posts point at them); old enough to post anywhere.
const userRows = [...users].map(
  ([author, id]) =>
    `INSERT OR IGNORE INTO users (id, name, name_key, provider, provider_id, created_at) VALUES (${q(id)}, ${q(userName(author))}, ${q(userName(author).toLowerCase())}, 'import', ${q(author)}, unixepoch() - 400 * 86400);`,
);
sql.unshift(...userRows);
sql.push("UPDATE communities SET post_count = (SELECT COUNT(*) FROM posts WHERE posts.community_id = communities.id AND removed = 0 AND deleted = 0);");

const file = join(CACHE, "seed.sql");
writeFileSync(file, sql.join("\n") + "\n");
console.log(`${unique.length} posts, ${commentTotal} comments, ${users.size} authors → ${file}`);

// LOCAL database only.
execFileSync("npx", ["wrangler", "d1", "execute", "opentrader-community", "--env", "local", "--local", "--file", file], { cwd: ROOT, stdio: "inherit", shell: true });
