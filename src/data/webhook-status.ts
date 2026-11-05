/*
 * The Alerts log's "Webhook status" line: what an event's webhook came to, in
 * the reference app's words ("Webhook successfully delivered", "Webhook
 * delivery failed — 404 Not Found.").
 */
import type { WebhookOutcome } from "./alert-store";

const STATUS_TEXT: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  408: "Request Timeout",
  410: "Gone",
  411: "Length Required",
  413: "Payload Too Large",
  415: "Unsupported Media Type",
  422: "Unprocessable Content",
  429: "Too Many Requests",
  500: "Internal Server Error",
  501: "Not Implemented",
  502: "Bad Gateway",
  503: "Service Temporarily Unavailable",
  504: "Gateway Timeout",
};

function httpError(code: number): string {
  const text = STATUS_TEXT[code] ?? (code >= 400 && code < 500 ? "Client Error" : code >= 500 && code < 600 ? "Server Error" : "");
  return text ? `${code} ${text}` : String(code);
}

/** Longer errors are cut to this many characters (an ellipsis ends them). */
const MAX_ERROR = 100;

export type WebhookStatus = { ok: boolean; text: string };

/** The line for an event's webhook, or null when none was sent. */
export function webhookStatus(w: WebhookOutcome | undefined): WebhookStatus | null {
  if (!w) return null;
  if (w.httpCode != null && w.httpCode >= 200 && w.httpCode < 300) return { ok: true, text: "Webhook successfully delivered" };
  if (w.httpCode == null && w.error == null) return null;
  const why = w.error ?? httpError(w.httpCode!);
  const cut = why.length <= MAX_ERROR ? `${why}.` : `${why.slice(0, MAX_ERROR - 1).trim()}…`;
  return { ok: false, text: `Webhook delivery failed — ${cut}` };
}
