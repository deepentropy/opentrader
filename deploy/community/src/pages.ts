/*
 * The website's pages (the build of src/community-site, in ./site). Each page
 * is sent with its own title, description and content written in, so search
 * engines and shared links see what it holds without running the script; the
 * script then replaces that content with the live page. Plus robots.txt, the
 * sitemap, one address per page (others redirect to it) and a real "not
 * found" for the rest.
 *
 * Search engines index a page only when a member wrote in it: the bot's
 * threads without a member's reply, the ticker pages holding only those, and
 * the account pages are kept out of their index and of the sitemap.
 */
import { Env } from "./env";
import { BOT } from "./bot";
import { utcDate } from "../../../src/community-shared/dates";
import { SUGGESTIONS, THEME_RE, TICKER_RE, escapeHtml } from "./util";

const SITE = "OpenTrader Community";
const DEFAULT_DESCRIPTION = "Discussions per ticker and per theme: stocks, options, penny stocks, crypto. Free and open source.";
const LIST_MAX = 50;
const COMMENTS_MAX = 200;

type Page = {
  title: string;
  description?: string;
  /** Written into the page's root, replaced by the script. */
  content?: string;
  /** Kept out of search engines' index. */
  noindex?: boolean;
  status?: number;
  /** The page's own address, when this one differs (a member's name in other capitals). */
  redirect?: string;
};

/** A reply or a page of the website, or null when the address isn't one of the website's. */
export async function page(env: Env, request: Request, url: URL): Promise<Response | null> {
  if ((request.method !== "GET" && request.method !== "HEAD") || !env.ASSETS) return null;
  const path = url.pathname;
  if (path === "/robots.txt") {
    return new Response(`User-agent: *\nAllow: /\nDisallow: /auth/\nSitemap: ${env.PUBLIC_URL}/sitemap.xml\n`, { headers: { "content-type": "text/plain" } });
  }
  if (path === "/sitemap.xml") return sitemap(env);
  if (isFile(path)) return null;
  let parts: string[];
  try {
    parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return notFound(env, url);
  }
  // /search, /tickers and /suggestions are API addresses too: only a browser gets the page.
  if (parts.length === 1 && ["search", "tickers", "suggestions"].includes(parts[0]) && !(request.headers.get("Accept") ?? "").includes("text/html")) return null;
  const moved = canonicalPath(parts);
  if (moved === null) return null;
  if (moved !== path) return Response.redirect(`${env.PUBLIC_URL}${moved}${url.search}`, 301);
  const p = await pageFor(env, parts);
  if (p.redirect) return Response.redirect(`${env.PUBLIC_URL}${p.redirect}${url.search}`, 301);
  return render(env, url, p, moved);
}

/** The website's page for an address no API route answers: "not found". */
export async function notFound(env: Env, url: URL): Promise<Response> {
  if (!env.ASSETS) return new Response("Not found.", { status: 404 });
  return render(env, url, {
    title: `Page not found · ${SITE}`,
    content: `${nav()}<h1>Page not found</h1><p>This page doesn't exist. <a href="/">Back to the community</a>.</p>`,
    noindex: true,
    status: 404,
  });
}

/** A file of the website (the script, styles, pictures, the sign-in page): served as is. */
export const isFile = (path: string) => path.startsWith("/assets/") || /\.(html|js|css|png|ico|svg|txt|xml|json|webmanifest|woff2?)$/i.test(path);

/**
 * The one address of a website page (tickers in capitals, no trailing slash,
 * former communities on their successor), or null when it isn't a page.
 */
export function canonicalPath(parts: string[]): string | null {
  const [a, b, c, ...rest] = parts;
  if (rest.length) return null;
  const enc = (s: string) => encodeURIComponent(s);
  switch (a) {
    case undefined:
      return "/";
    case "t": {
      const t = b?.toUpperCase();
      if (!t || !TICKER_RE.test(t) || (c !== undefined && c !== "about")) return null;
      return `/t/${enc(t)}${c ? "/about" : ""}`;
    }
    case "c":
      if (!b || !THEME_RE.test(b) || (c !== undefined && c !== "about")) return null;
      if (b === "suggestions" && !c) return "/suggestions";
      // Former theme communities: General took them in.
      return `/c/general${c ? "/about" : ""}`;
    case "p":
    case "u":
      return b && c === undefined ? `/${a}/${enc(b)}` : null;
    case "suggestions":
      return c === undefined && (b === undefined || b === "new") ? `/suggestions${b ? "/new" : ""}` : null;
    case "following":
      return b === undefined ? "/" : null;
    case "search":
    case "tickers":
    case "submit":
    case "notifications":
    case "account":
    case "mod":
    case "contact":
    case "signin":
      return b === undefined ? `/${a}` : null;
    default:
      return null;
  }
}

async function render(env: Env, url: URL, p: Page, path?: string): Promise<Response> {
  const shell = await env.ASSETS!.fetch(new Request(new URL("/", url)));
  const description = p.description ?? DEFAULT_DESCRIPTION;
  const canonical = path && !p.noindex ? `${env.PUBLIC_URL}${path}` : null;
  const head =
    (canonical ? `<link rel="canonical" href="${escapeHtml(canonical)}"><meta property="og:url" content="${escapeHtml(canonical)}">` : "") +
    (p.noindex ? `<meta name="robots" content="noindex">` : "");
  let rewriter = new HTMLRewriter()
    .on("title", { element: (e) => void e.setInnerContent(p.title) })
    .on('meta[name="description"]', { element: (e) => void e.setAttribute("content", description) })
    .on('meta[property="og:title"]', { element: (e) => void e.setAttribute("content", p.title) })
    .on('meta[property="og:description"]', { element: (e) => void e.setAttribute("content", description) });
  if (head) rewriter = rewriter.on("head", { element: (e) => void e.append(head, { html: true }) });
  if (p.content) rewriter = rewriter.on("#root", { element: (e) => void e.setInnerContent(`<main class="cs-ssr">${p.content}</main>`, { html: true }) });
  const res = rewriter.transform(shell);
  const headers = new Headers(res.headers);
  if (p.noindex) headers.set("X-Robots-Tag", "noindex");
  return new Response(res.body, { status: p.status ?? 200, headers });
}

// ── Pages ────────────────────────────────────────────────────────────────

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);
const plain = (s: string) => s.replace(/[#*_~`>|[\]()]/g, " ").replace(/\s+/g, " ").trim();
const h = escapeHtml;

/** Posts a member wrote, or that a member replied to: the ones search engines may index. */
const INDEXABLE = `p.removed = 0 AND p.deleted = 0 AND (p.author_id IS NOT '${BOT}' OR EXISTS (
  SELECT 1 FROM comments k WHERE k.post_id = p.id AND k.removed = 0 AND k.deleted = 0 AND k.author_id IS NOT '${BOT}'))`;

const LIST_SELECT = `SELECT p.id, p.title, p.body, p.created_at, p.comment_count, COALESCE(u.name, p.external_author) AS author, c.title AS community
  FROM posts p LEFT JOIN users u ON u.id = p.author_id JOIN communities c ON c.id = p.community_id`;

type ListRow = { id: string; title: string; body: string; created_at: number; comment_count: number; author: string | null; community: string };

const UTILITY: Record<string, string> = {
  search: "Search",
  submit: "New post",
  notifications: "Notifications",
  account: "Account",
  mod: "Moderation queue",
  contact: "Contact and reports",
  signin: "Sign in",
};

async function pageFor(env: Env, parts: string[]): Promise<Page> {
  const [a, b, c] = parts;
  if (a === undefined) return home(env);
  if (c === "about") return { title: `About ${a === "t" ? `$${b.toUpperCase()}` : "General"} · ${SITE}`, noindex: true };
  if (a === "suggestions") return b === "new" ? { title: `Suggest a feature · ${SITE}`, noindex: true } : suggestions(env);
  if (a === "tickers") return tickers(env);
  if (a === "p") return post(env, b);
  if (a === "u") return member(env, b);
  if (a === "t") return ticker(env, b.toUpperCase());
  if (a === "c") return general(env);
  return { title: `${UTILITY[a]} · ${SITE}`, noindex: true };
}

function nav(): string {
  return `<nav><a href="/">${SITE}</a> · <a href="/tickers">Tickers</a> · <a href="/c/general">General</a> · <a href="/suggestions">Suggestions</a></nav>`;
}

function postList(rows: ListRow[], empty: string): string {
  if (!rows.length) return `<p>${h(empty)}</p>`;
  const items = rows.map((r) => {
    const by = r.author ? ` by ${h(r.author)}` : "";
    const replies = r.comment_count ? `, ${r.comment_count} ${r.comment_count === 1 ? "reply" : "replies"}` : "";
    return `<li><a href="/p/${h(r.id)}">${h(r.title)}</a> <small>${h(r.community)}${by}, <time datetime="${new Date(r.created_at * 1000).toISOString()}">${utcDate(r.created_at)}</time>${replies}</small><p>${h(clip(plain(r.body), 240))}</p></li>`;
  });
  return `<ul>${items.join("")}</ul>`;
}

/** A post's text: paragraphs, line breaks kept, the formatting marks dropped. */
function text(body: string): string {
  return body
    .split(/\n{2,}/)
    .map((para) => para.replace(/^#{1,6}\s+/gm, "").replace(/(\*\*|__|\*|_|~~|`)(.+?)\1/g, "$2").trim())
    .filter(Boolean)
    .map((para) => `<p>${h(para).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

async function home(env: Env): Promise<Page> {
  const { results } = await env.DB.prepare(`${LIST_SELECT} WHERE ${INDEXABLE} AND p.community_id IS NOT ? ORDER BY p.created_at DESC LIMIT ?`)
    .bind(SUGGESTIONS, LIST_MAX)
    .all<ListRow>();
  return { title: SITE, content: `${nav()}<h1>${SITE}</h1><p>${h(DEFAULT_DESCRIPTION)}</p><h2>Latest posts</h2>${postList(results, "No posts yet.")}` };
}

async function general(env: Env): Promise<Page> {
  const c = await env.DB.prepare("SELECT title, description FROM communities WHERE id = 'c:general'").first<{ title: string; description: string }>();
  const title = c?.title ?? "General";
  const { results } = await env.DB.prepare(`${LIST_SELECT} WHERE p.community_id = 'c:general' AND p.removed = 0 AND p.deleted = 0 ORDER BY p.created_at DESC LIMIT ?`)
    .bind(LIST_MAX)
    .all<ListRow>();
  const description = c?.description || `${title} discussions.`;
  return { title: `${title} · ${SITE}`, description, content: `${nav()}<h1>${h(title)}</h1><p>${h(description)}</p>${postList(results, "No posts yet.")}` };
}

async function ticker(env: Env, t: string): Promise<Page> {
  const { results } = await env.DB.prepare(
    `${LIST_SELECT} WHERE p.community_id = ? AND p.removed = 0 AND p.deleted = 0 ORDER BY p.created_at DESC LIMIT ?`,
  )
    .bind(`t:${t}`, LIST_MAX)
    .all<ListRow>();
  const indexed = await env.DB.prepare(`SELECT 1 FROM posts p WHERE p.community_id = ? AND ${INDEXABLE} LIMIT 1`).bind(`t:${t}`).first();
  const description = `Open ideas with their levels, analysis and questions about ${t}.`;
  return {
    title: `${t} · ${SITE}`,
    description,
    content: `${nav()}<h1>$${h(t)}</h1><p>${h(description)}</p>${postList(results, `No posts about $${t} yet.`)}`,
    noindex: !indexed,
  };
}

async function tickers(env: Env): Promise<Page> {
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.post_count, EXISTS (SELECT 1 FROM posts p WHERE p.community_id = c.id AND ${INDEXABLE}) AS indexed
     FROM communities c WHERE c.kind = 'ticker' AND c.post_count > 0 ORDER BY indexed DESC, c.post_count DESC LIMIT 500`,
  ).all<{ id: string; post_count: number; indexed: number }>();
  const items = results.map((r) => {
    const t = r.id.slice(2);
    return `<li><a href="/t/${h(encodeURIComponent(t))}">$${h(t)}</a> <small>${r.post_count} ${r.post_count === 1 ? "post" : "posts"}</small></li>`;
  });
  return {
    title: `Tickers · ${SITE}`,
    description: "The tickers members discuss, with their open ideas, analysis and questions.",
    content: `${nav()}<h1>Tickers</h1>${items.length ? `<ul>${items.join("")}</ul>` : "<p>No ticker discussed yet.</p>"}`,
  };
}

async function suggestions(env: Env): Promise<Page> {
  const { results } = await env.DB.prepare(`${LIST_SELECT} WHERE p.community_id = ? AND p.removed = 0 AND p.deleted = 0 ORDER BY p.useful_count DESC, p.created_at DESC LIMIT ?`)
    .bind(SUGGESTIONS, LIST_MAX)
    .all<ListRow>();
  const description = "Features members ask for in OpenTrader, with their status.";
  return { title: `Suggestions · ${SITE}`, description, content: `${nav()}<h1>Suggestions</h1><p>${h(description)}</p>${postList(results, "No suggestions yet.")}` };
}

async function post(env: Env, id: string): Promise<Page> {
  const p = await env.DB.prepare(
    `SELECT p.id, p.title, p.body, p.removed, p.deleted, p.created_at, p.community_id, c.title AS community,
       COALESCE(u.name, p.external_author) AS author, ${INDEXABLE} AS indexed
     FROM posts p JOIN communities c ON c.id = p.community_id LEFT JOIN users u ON u.id = p.author_id WHERE p.id = ?`,
  )
    .bind(id)
    .first<{ id: string; title: string; body: string; removed: number; deleted: number; created_at: number; community_id: string; community: string; author: string | null; indexed: number }>();
  if (!p) return { title: `Post not found · ${SITE}`, description: "This post doesn't exist.", content: `${nav()}<h1>Post not found</h1><p>This post doesn't exist.</p>`, noindex: true, status: 404 };
  if (p.removed) return { title: `Removed post · ${p.community} · ${SITE}`, description: "This post was removed by the moderators.", noindex: true };
  const where =
    p.community_id === SUGGESTIONS ? `<a href="/suggestions">Suggestions</a>` : p.community_id.startsWith("t:") ? `<a href="/t/${h(encodeURIComponent(p.community_id.slice(2)))}">${h(p.community)}</a>` : `<a href="/c/general">${h(p.community)}</a>`;
  const { results: comments } = await env.DB.prepare(
    `SELECT k.body, k.created_at, u.name AS author FROM comments k LEFT JOIN users u ON u.id = k.author_id
     WHERE k.post_id = ? AND k.removed = 0 AND k.deleted = 0 ORDER BY k.created_at LIMIT ?`,
  )
    .bind(id, COMMENTS_MAX)
    .all<{ body: string; created_at: number; author: string | null }>();
  const replies = comments
    .map((k) => `<article><p><small>${h(k.author ?? "Deleted account")}, <time datetime="${new Date(k.created_at * 1000).toISOString()}">${utcDate(k.created_at)}</time></small></p>${text(k.body)}</article>`)
    .join("");
  const body = p.deleted ? "<p>The author deleted this post.</p>" : text(p.body);
  return {
    title: `${clip(p.title, 90)} · ${p.community} · ${SITE}`,
    description: clip(plain(p.deleted ? "" : p.body) || `Discussion in ${p.community}.`, 200),
    content:
      `${nav()}<article><h1>${h(p.title)}</h1><p><small>${where} · ${h(p.author ?? "Deleted account")}, <time datetime="${new Date(p.created_at * 1000).toISOString()}">${utcDate(p.created_at)}</time></small></p>${body}</article>` +
      (comments.length ? `<section><h2>Replies</h2>${replies}</section>` : ""),
    noindex: !p.indexed,
  };
}

async function member(env: Env, name: string): Promise<Page> {
  const u = await env.DB.prepare("SELECT id, name, bio FROM users WHERE name_key = ?").bind(name.toLowerCase()).first<{ id: string; name: string; bio: string }>();
  if (!u) return { title: `Member not found · ${SITE}`, content: `${nav()}<h1>Member not found</h1><p>No member has this name.</p>`, noindex: true, status: 404 };
  if (u.name !== name) return { title: "", redirect: `/u/${encodeURIComponent(u.name)}` };
  const { results } = await env.DB.prepare(`${LIST_SELECT} WHERE p.author_id = ? AND p.removed = 0 AND p.deleted = 0 ORDER BY p.created_at DESC LIMIT ?`)
    .bind(u.id, LIST_MAX)
    .all<ListRow>();
  const description = clip(u.bio || `${u.name}'s ideas and their outcomes, winners and losers.`, 200);
  return {
    title: `${u.name} · ${SITE}`,
    description,
    content: `${nav()}<h1>${h(u.name)}</h1><p>${h(description)}</p>${postList(results, "No posts yet.")}`,
    noindex: u.id === BOT || !results.length,
  };
}

async function sitemap(env: Env): Promise<Response> {
  const { results: communities } = await env.DB.prepare(
    `SELECT DISTINCT p.community_id AS id FROM posts p WHERE p.community_id LIKE 't:%' AND ${INDEXABLE}`,
  ).all<{ id: string }>();
  const { results: posts } = await env.DB.prepare(
    `SELECT p.id, COALESCE(p.edited_at, p.created_at) AS at FROM posts p WHERE ${INDEXABLE} ORDER BY p.created_at DESC LIMIT 5000`,
  ).all<{ id: string; at: number }>();
  const url = (loc: string, at?: number) =>
    `<url><loc>${escapeHtml(env.PUBLIC_URL + loc)}</loc>${at ? `<lastmod>${new Date(at * 1000).toISOString().slice(0, 10)}</lastmod>` : ""}</url>`;
  const body = [
    url("/"),
    url("/tickers"),
    url("/c/general"),
    url("/suggestions"),
    ...communities.map((c) => url(`/t/${encodeURIComponent(c.id.slice(2))}`)),
    ...posts.map((p) => url(`/p/${p.id}`, p.at)),
  ].join("");
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${body}</urlset>`, {
    headers: { "content-type": "application/xml" },
  });
}
