/*
 * Live comments (#208): one Durable Object per post holds the WebSockets of
 * the people reading it (hibernating between messages, so an idle room costs
 * nothing) and passes each new comment to them.
 *
 *   GET /posts/:id/live (WebSocket)  → the room
 *   new comment                      → POST http://room/broadcast
 */
import { DurableObject } from "cloudflare:workers";
import { Env } from "./env";
import { HttpError } from "./util";

/** Readers of one post at most (a busy thread). */
const MAX_SOCKETS = 500;

export class PostRoom extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/broadcast" && request.method === "POST") {
      const message = await request.text();
      for (const ws of this.ctx.getWebSockets()) {
        try {
          ws.send(message);
        } catch {
          // A socket closing as we send.
        }
      }
      return new Response(null, { status: 204 });
    }
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("expected a WebSocket", { status: 426 });
    if (this.ctx.getWebSockets().length >= MAX_SOCKETS) return new Response("too many readers", { status: 503 });
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  // Readers send nothing; a message is ignored.
  async webSocketMessage(): Promise<void> {}

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try {
      ws.close(code === 1005 ? 1000 : code, "closed");
    } catch {
      // Already closed.
    }
  }
}

/** GET /posts/:id/live */
export function joinRoom(env: Env, request: Request, postId: string): Promise<Response> {
  if (!env.ROOMS) throw new HttpError(503, "Live updates are not available.");
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") throw new HttpError(426, "Expected a WebSocket.");
  return env.ROOMS.get(env.ROOMS.idFromName(postId)).fetch(request);
}

/** Tells the post's readers (best effort: a failure loses only the live update). */
export async function broadcast(env: Env, postId: string, message: unknown): Promise<void> {
  if (!env.ROOMS) return;
  try {
    await env.ROOMS.get(env.ROOMS.idFromName(postId)).fetch("http://room/broadcast", { method: "POST", body: JSON.stringify(message) });
  } catch (e) {
    console.warn("[live] broadcast failed", e);
  }
}
