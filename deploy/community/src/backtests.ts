/*
 * Backtests: a public strategy script run on many stocks, posted by the project through the posting API in the
 * Backtests community. The post holds the summary (posts.backtest, JSON); the per-stock table and each stock's bars
 * and trades are files in the IMAGES bucket under backtests/<post id>/, uploaded with the key and served while the
 * post is shown.
 */
import { Env } from "./env";
import { User } from "./auth";
import { postRow } from "./api";
import { HttpError, json } from "./util";

const MAX_SUMMARY = 64 * 1024;
const MAX_FILE = 4 * 1024 * 1024;
/** The files of a backtest: the per-stock table, one file per stock. */
const FILE_RE = /^(stocks\.json|s\/[A-Z0-9][A-Z0-9.\-]{0,11}\.json)$/;

const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);

/** The summary sent with a new backtest, checked for the fields the pages read; stored as sent. */
export function parseBacktest(raw: unknown): string {
  const b = raw as Record<string, any> | null;
  const ok =
    !!b && typeof b === "object" &&
    typeof b.strategy?.name === "string" && typeof b.strategy?.author === "string" &&
    typeof b.rules === "string" && typeof b.interval === "string" &&
    num(b.first) && num(b.split) && num(b.last) &&
    typeof b.universe?.label === "string" && num(b.universe?.count) &&
    Array.isArray(b.inputs) && Array.isArray(b.periods) && typeof b.summary?.default?.out === "object" && typeof b.summary?.optimized?.out === "object";
  if (!ok) throw new HttpError(400, "The backtest's summary is incomplete.");
  const text = JSON.stringify(b);
  if (text.length > MAX_SUMMARY) throw new HttpError(400, "The backtest's summary is too long.");
  return text;
}

async function ownBacktest(env: Env, u: User, postId: string) {
  const row = await postRow(env, postId);
  if (row.type !== "backtest" || row.author_id !== u.id || row.deleted) throw new HttpError(403, "Not a backtest of this account.");
  return row;
}

/** A file of the account's backtest (the request's body as is). */
export async function putFile(env: Env, u: User, request: Request, postId: string, file: string): Promise<Response> {
  if (!FILE_RE.test(file)) throw new HttpError(400, "Unknown file.");
  await ownBacktest(env, u, postId);
  if (!env.IMAGES) throw new HttpError(503, "Files can't be stored right now.");
  const bytes = await request.arrayBuffer();
  if (!bytes.byteLength || bytes.byteLength > MAX_FILE) throw new HttpError(413, "Empty or too large.");
  await env.IMAGES.put(`backtests/${postId}/${file}`, bytes, { httpMetadata: { contentType: "application/json" } });
  return json({ ok: true, bytes: bytes.byteLength });
}

/** The account replaces its backtest's summary. */
export async function editBacktest(env: Env, u: User, postId: string, body: any): Promise<Response> {
  await ownBacktest(env, u, postId);
  await env.DB.prepare("UPDATE posts SET backtest = ? WHERE id = ?").bind(parseBacktest(body?.backtest), postId).run();
  return json({ ok: true });
}

/** GET /backtests/:postId/<file> — a file of a backtest that is still shown. */
export async function serveFile(env: Env, postId: string, file: string): Promise<Response> {
  if (!FILE_RE.test(file)) throw new HttpError(404, "Not found.");
  const row = await env.DB.prepare("SELECT type, removed, deleted FROM posts WHERE id = ?").bind(postId).first<{ type: string; removed: number; deleted: number }>();
  if (!row || row.type !== "backtest" || row.removed || row.deleted || !env.IMAGES) throw new HttpError(404, "Not found.");
  const obj = await env.IMAGES.get(`backtests/${postId}/${file}`);
  if (!obj) throw new HttpError(404, "Not found.");
  return new Response(obj.body, {
    headers: {
      "content-type": obj.httpMetadata?.contentType ?? "application/json",
      // A re-upload replaces a file; a removal is checked above.
      "cache-control": "public, max-age=3600",
    },
  });
}
