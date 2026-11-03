/*
 * The website's pages (the build of src/community-site, in ./site): post and
 * community addresses get the page with their own title and description, so
 * shared links and search results show what they hold. The page itself loads
 * the content. Plus robots.txt and a sitemap of the communities and posts.
 */
import { Env } from "./env";
import { escapeHtml, parseCommunityId } from "./util";

const SITE = "OpenTrader Community";

type Meta = { title: string; description: string; status?: number };

/** The page for this address, or null when it isn't one of the website's. */
export async function page(env: Env, request: Request, url: URL): Promise<Response | null> {
  if (request.method !== "GET" || !env.ASSETS) return null;
  const path = url.pathname;
  if (path === "/robots.txt") {
    return new Response(`User-agent: *\nAllow: /\nDisallow: /auth/\nSitemap: ${env.PUBLIC_URL}/sitemap.xml\n`, { headers: { "content-type": "text/plain" } });
  }
  if (path === "/sitemap.xml") return sitemap(env);
  const m = /^\/(p|t|c|u)\/([^/]+)\/?$/.exec(path);
  if (!m) return null;
  const meta = await metaFor(env, m[1], decodeURIComponent(m[2]));
  const shell = await env.ASSETS.fetch(new Request(new URL("/", url)));
  const canonical = `${env.PUBLIC_URL}${path}`;
  const res = new HTMLRewriter()
    .on("title", { element: (e) => void e.setInnerContent(meta.title) })
    .on('meta[name="description"]', { element: (e) => void e.setAttribute("content", meta.description) })
    .on('meta[property="og:title"]', { element: (e) => void e.setAttribute("content", meta.title) })
    .on('meta[property="og:description"]', { element: (e) => void e.setAttribute("content", meta.description) })
    .on("head", {
      element: (e) =>
        void e.append(`<link rel="canonical" href="${escapeHtml(canonical)}"><meta property="og:url" content="${escapeHtml(canonical)}">`, { html: true }),
    })
    .transform(shell);
  return new Response(res.body, { status: meta.status ?? 200, headers: res.headers });
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);
const plain = (s: string) => s.replace(/[#*_~`>|[\]()]/g, " ").replace(/\s+/g, " ").trim();

async function metaFor(env: Env, kind: string, key: string): Promise<Meta> {
  if (kind === "u") {
    const u = await env.DB.prepare("SELECT name, bio FROM users WHERE name_key = ?").bind(key.toLowerCase()).first<{ name: string; bio: string }>();
    if (!u) return { title: `Member not found · ${SITE}`, description: "", status: 404 };
    return { title: `${u.name} · ${SITE}`, description: clip(u.bio || `${u.name}'s ideas and their outcomes, winners and losers.`, 200) };
  }
  if (kind === "p") {
    const p = await env.DB.prepare(
      "SELECT p.title, p.body, p.removed, p.deleted, c.title AS community FROM posts p JOIN communities c ON c.id = p.community_id WHERE p.id = ?",
    )
      .bind(key)
      .first<{ title: string; body: string; removed: number; deleted: number; community: string }>();
    if (!p) return { title: `Post not found · ${SITE}`, description: "This post doesn't exist.", status: 404 };
    if (p.removed) return { title: `Removed post · ${p.community} · ${SITE}`, description: "This post was removed by the moderators." };
    return {
      title: `${clip(p.title, 90)} · ${p.community} · ${SITE}`,
      description: clip(plain(p.deleted ? "" : p.body) || `Discussion in ${p.community}.`, 200),
    };
  }
  const parsed = parseCommunityId(`${kind}:${key}`);
  if (!parsed) return { title: `Not found · ${SITE}`, description: "", status: 404 };
  if (parsed.kind === "ticker") {
    return { title: `${parsed.key} · ${SITE}`, description: `Open ideas with their levels, analysis and questions about ${parsed.key}.` };
  }
  const c = await env.DB.prepare("SELECT title, description FROM communities WHERE id = ?").bind(`c:${parsed.key}`).first<{ title: string; description: string }>();
  if (!c) return { title: `Community not found · ${SITE}`, description: "", status: 404 };
  return { title: `${c.title} · ${SITE}`, description: c.description || `${c.title} discussions.` };
}

async function sitemap(env: Env): Promise<Response> {
  const { results: communities } = await env.DB.prepare("SELECT id FROM communities WHERE post_count > 0 OR kind = 'theme'").all<{ id: string }>();
  const { results: posts } = await env.DB.prepare(
    "SELECT id, COALESCE(edited_at, created_at) AS at FROM posts WHERE removed = 0 AND deleted = 0 ORDER BY created_at DESC LIMIT 5000",
  ).all<{ id: string; at: number }>();
  const url = (loc: string, at?: number) =>
    `<url><loc>${escapeHtml(env.PUBLIC_URL + loc)}</loc>${at ? `<lastmod>${new Date(at * 1000).toISOString().slice(0, 10)}</lastmod>` : ""}</url>`;
  const body = [
    url("/"),
    ...communities.map((c) => url(c.id.startsWith("t:") ? `/t/${encodeURIComponent(c.id.slice(2))}` : `/c/${c.id.slice(2)}`)),
    ...posts.map((p) => url(`/p/${p.id}`, p.at)),
  ].join("");
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${body}</urlset>`, {
    headers: { "content-type": "application/xml" },
  });
}
