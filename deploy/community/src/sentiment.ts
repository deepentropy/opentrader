/*
 * Bullish / bearish votes on ticker communities: one click, one vote per
 * member, ticker and day, changeable during the day. The tally of today and
 * of the last two weeks shows at the top of the community.
 */
import { Env } from "./env";
import { User } from "./auth";
import { ensureCommunity, findCommunity, writer } from "./api";
import { notBannedIn } from "./members";
import { HttpError, json, now } from "./util";

const HISTORY_DAYS = 14;

export const today = (at = now()) => Math.floor(at / 86_400);

async function tally(env: Env, communityId: string, user: User | null) {
  const day = today();
  const { results } = await env.DB.prepare(
    `SELECT day, SUM(value = 1) AS bull, SUM(value = -1) AS bear FROM sentiment
      WHERE community_id = ? AND day > ? GROUP BY day ORDER BY day`,
  )
    .bind(communityId, day - HISTORY_DAYS)
    .all<{ day: number; bull: number; bear: number }>();
  const mine = user
    ? (await env.DB.prepare("SELECT value FROM sentiment WHERE community_id = ? AND user_id = ? AND day = ?").bind(communityId, user.id, day).first<{ value: number }>())?.value ?? 0
    : 0;
  const t = results.find((r) => r.day === day);
  return { today: { bull: t?.bull ?? 0, bear: t?.bear ?? 0 }, mine, days: results };
}

/** GET /communities/:id/sentiment */
export async function getSentiment(env: Env, user: User | null, id: string): Promise<Response> {
  const c = await findCommunity(env, id);
  if (c.kind !== "ticker") throw new HttpError(400, "Votes are for ticker communities.");
  return json(await tally(env, c.id, user));
}

/** POST /communities/:id/sentiment {value: 1 | -1 | 0} */
export async function setSentiment(env: Env, user: User | null, id: string, body: any): Promise<Response> {
  const u = writer(user);
  const value = Number(body?.value);
  if (![1, -1, 0].includes(value)) throw new HttpError(400, "value must be 1, -1 or 0");
  const c = await ensureCommunity(env, id);
  if (c.kind !== "ticker") throw new HttpError(400, "Votes are for ticker communities.");
  await notBannedIn(env, u, c.id);
  const day = today();
  await (value === 0
    ? env.DB.prepare("DELETE FROM sentiment WHERE community_id = ? AND user_id = ? AND day = ?").bind(c.id, u.id, day)
    : env.DB.prepare(
        "INSERT INTO sentiment (community_id, user_id, day, value) VALUES (?, ?, ?, ?) ON CONFLICT (community_id, user_id, day) DO UPDATE SET value = excluded.value",
      ).bind(c.id, u.id, day, value)
  ).run();
  return json(await tally(env, c.id, u));
}
