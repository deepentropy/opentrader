/*
 * Charts shared in posts and replies: the author's chart state (symbol,
 * interval, drawings: "Open on my chart" in the app) and its picture, stored
 * in the IMAGES bucket under charts/<post id> (served at /images/<post id>),
 * comments/<comment id> (/images/c/<comment id>) and snapshots/<id>.
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

type Folder = "charts" | "comments" | "snapshots";

export async function saveImage(env: Env, id: string, image: { bytes: Uint8Array; type: string }, folder: Folder = "charts"): Promise<void> {
  if (!env.IMAGES) throw new HttpError(503, "Pictures can't be stored right now.");
  await env.IMAGES.put(`${folder}/${id}`, image.bytes, { httpMetadata: { contentType: image.type } });
}

export async function deleteImages(env: Env, ids: string[], folder: Folder = "charts"): Promise<void> {
  if (env.IMAGES && ids.length) await env.IMAGES.delete(ids.map((id) => `${folder}/${id}`));
}

/** GET /images/:postId, /images/c/:commentId — the picture of a post or a reply that is still shown. */
export async function serveImage(env: Env, id: string, folder: "charts" | "comments" = "charts"): Promise<Response> {
  const row = await env.DB.prepare(`SELECT has_image, removed, deleted FROM ${folder === "charts" ? "posts" : "comments"} WHERE id = ?`)
    .bind(id)
    .first<{ has_image: number; removed: number; deleted: number }>();
  if (!row || !row.has_image || row.removed || row.deleted || !env.IMAGES) throw new HttpError(404, "No picture.");
  const obj = await env.IMAGES.get(`${folder}/${id}`);
  if (!obj) throw new HttpError(404, "No picture.");
  return new Response(obj.body, {
    headers: {
      "content-type": obj.httpMetadata?.contentType ?? "image/webp",
      // A picture never changes; a removal is checked above, so keep browser caching short.
      "cache-control": "public, max-age=3600",
    },
  });
}
