/*
 * Charts shared in posts: the author's chart state (symbol, interval,
 * drawings: "Open on my chart" in the app) and its picture, stored in the
 * IMAGES bucket under charts/<post id> and served at /images/<post id>.
 */
import { Env } from "./env";
import { HttpError } from "./util";

export type SharedChart = { symbol: string; interval: string; drawings: unknown[] };

const MAX_DRAWINGS = 200;
const MAX_CHART_JSON = 200_000;
const MAX_IMAGE_BYTES = 1_500_000;
const IMAGE_TYPES = ["image/webp", "image/png", "image/jpeg"];

/** The chart of a new post, checked; null when there is none. */
export function parseChart(v: unknown): SharedChart | null {
  if (v === undefined || v === null) return null;
  const c = v as Record<string, unknown>;
  const symbol = typeof c.symbol === "string" ? c.symbol : "";
  const interval = typeof c.interval === "string" ? c.interval : "";
  if (!/^[A-Za-z0-9:._!\-]{1,40}$/.test(symbol) || !/^[0-9A-Za-z]{1,8}$/.test(interval)) throw new HttpError(400, "The chart is not valid.");
  const drawings = Array.isArray(c.drawings) ? c.drawings.filter((d) => d && typeof d === "object").slice(0, MAX_DRAWINGS) : [];
  const chart = { symbol, interval, drawings };
  if (JSON.stringify(chart).length > MAX_CHART_JSON) throw new HttpError(400, "The chart has too many drawings to share.");
  return chart;
}

/** The picture of a new post (base64), checked; null when there is none. */
export function parseImage(data: unknown, type: unknown): { bytes: Uint8Array; type: string } | null {
  if (data === undefined || data === null || data === "") return null;
  if (typeof data !== "string" || typeof type !== "string" || !IMAGE_TYPES.includes(type)) throw new HttpError(400, "The picture is not valid.");
  let bin: string;
  try {
    bin = atob(data);
  } catch {
    throw new HttpError(400, "The picture is not valid.");
  }
  if (bin.length > MAX_IMAGE_BYTES) throw new HttpError(413, "The picture is too large.");
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { bytes, type };
}

export async function saveImage(env: Env, postId: string, image: { bytes: Uint8Array; type: string }): Promise<void> {
  if (!env.IMAGES) throw new HttpError(503, "Pictures can't be stored right now.");
  await env.IMAGES.put(`charts/${postId}`, image.bytes, { httpMetadata: { contentType: image.type } });
}

export async function deleteImages(env: Env, postIds: string[]): Promise<void> {
  if (env.IMAGES && postIds.length) await env.IMAGES.delete(postIds.map((id) => `charts/${id}`));
}

/** GET /images/:postId — the picture of a post that is still shown. */
export async function serveImage(env: Env, postId: string): Promise<Response> {
  const post = await env.DB.prepare("SELECT has_image, removed, deleted FROM posts WHERE id = ?").bind(postId).first<{ has_image: number; removed: number; deleted: number }>();
  if (!post || !post.has_image || post.removed || post.deleted || !env.IMAGES) throw new HttpError(404, "No picture.");
  const obj = await env.IMAGES.get(`charts/${postId}`);
  if (!obj) throw new HttpError(404, "No picture.");
  return new Response(obj.body, {
    headers: {
      "content-type": obj.httpMetadata?.contentType ?? "image/webp",
      // A post's picture never changes; a removal is checked above, so keep browser caching short.
      "cache-control": "public, max-age=3600",
    },
  });
}
