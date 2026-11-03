/*
 * Chart snapshots the app sends to the member's account ("Send to Community
 * snapshots"), so a post or a reply written on the website can carry one.
 * Private: attaching one copies its picture to the post or the reply. The
 * newest few are kept.
 */
import { Env } from "./env";
import { User } from "./auth";
import { SharedChart, deleteImages, parseChart, parseImage, saveImage } from "./charts";
import { requireUser } from "./api";
import { HttpError, json, newId, now, str } from "./util";

const KEEP = 12;

/** POST /me/snapshots {chart, image, image_type} */
export async function addSnapshot(env: Env, user: User | null, body: any): Promise<Response> {
  const u = requireUser(user);
  const chart = parseChart(body?.chart);
  const image = parseImage(body?.image, body?.image_type);
  if (!chart || !image) throw new HttpError(400, "A snapshot is a chart and its picture.");
  const id = newId();
  await saveImage(env, id, image, "snapshots");
  await env.DB.prepare("INSERT INTO snapshots (id, user_id, chart, image_type, created_at) VALUES (?, ?, ?, ?, ?)").bind(id, u.id, JSON.stringify(chart), image.type, now()).run();
  const { results: old } = await env.DB.prepare("SELECT id FROM snapshots WHERE user_id = ? ORDER BY created_at DESC LIMIT -1 OFFSET ?").bind(u.id, KEEP).all<{ id: string }>();
  if (old.length) {
    await deleteImages(env, old.map((s) => s.id), "snapshots");
    await env.DB.batch(old.map((s) => env.DB.prepare("DELETE FROM snapshots WHERE id = ?").bind(s.id)));
  }
  return json({ snapshot: { id, symbol: chart.symbol, interval: chart.interval, created_at: now() } }, 201);
}

/** GET /me/snapshots — newest first. */
export async function listSnapshots(env: Env, user: User | null): Promise<Response> {
  const u = requireUser(user);
  const { results } = await env.DB.prepare("SELECT id, chart, created_at FROM snapshots WHERE user_id = ? ORDER BY created_at DESC").bind(u.id).all<{ id: string; chart: string; created_at: number }>();
  return json({
    snapshots: results.map((s) => {
      const c = JSON.parse(s.chart) as SharedChart;
      return { id: s.id, symbol: c.symbol, interval: c.interval, created_at: s.created_at };
    }),
  });
}

/** GET /me/snapshots/:id/image — its owner only (the page fetches it with the session). */
export async function snapshotImage(env: Env, user: User | null, id: string): Promise<Response> {
  const u = requireUser(user);
  const s = await env.DB.prepare("SELECT user_id FROM snapshots WHERE id = ?").bind(id).first<{ user_id: string }>();
  if (!s || s.user_id !== u.id || !env.IMAGES) throw new HttpError(404, "No snapshot.");
  const obj = await env.IMAGES.get(`snapshots/${id}`);
  if (!obj) throw new HttpError(404, "No snapshot.");
  return new Response(obj.body, { headers: { "content-type": obj.httpMetadata?.contentType ?? "image/png", "cache-control": "private, max-age=3600" } });
}

/** DELETE /me/snapshots/:id */
export async function deleteSnapshot(env: Env, user: User | null, id: string): Promise<Response> {
  const u = requireUser(user);
  const res = await env.DB.prepare("DELETE FROM snapshots WHERE id = ? AND user_id = ?").bind(id, u.id).run();
  if (res.meta.changes) await deleteImages(env, [id], "snapshots");
  return json({ ok: true });
}

/** The member's snapshot, for a post or a reply: its chart and picture. */
export async function takeSnapshot(env: Env, u: User, id: string): Promise<{ chart: SharedChart; image: { bytes: Uint8Array; type: string } }> {
  const s = await env.DB.prepare("SELECT chart, image_type, user_id FROM snapshots WHERE id = ?").bind(str(id)).first<{ chart: string; image_type: string; user_id: string }>();
  if (!s || s.user_id !== u.id) throw new HttpError(400, "This snapshot isn't yours, or is gone.");
  const obj = env.IMAGES ? await env.IMAGES.get(`snapshots/${id}`) : null;
  if (!obj) throw new HttpError(400, "This snapshot's picture is gone.");
  const bytes = new Uint8Array(await obj.arrayBuffer());
  return { chart: JSON.parse(s.chart), image: { bytes, type: s.image_type } };
}
