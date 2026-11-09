/*
 * Small helpers shared by the routes: responses, ids, hashing, and the
 * ranking/validation rules (pure, unit-tested in test/rules.test.ts).
 */

export class HttpError extends Error {
  /** `extra`: more fields of the error answer (e.g. `check: true`). */
  constructor(public status: number, message: string, public extra: Record<string, unknown> = {}) {
    super(message);
  }
}

/** A JSON answer; `T`: its shape in the API contract (src/community-shared/contract.ts), when typed. */
export function json<T = unknown>(data: T, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });
}

export const now = (): number => Math.floor(Date.now() / 1000);

const ID_CHARS = "0123456789abcdefghijklmnopqrstuvwxyz";
/** Random id: 10 base-36 characters (~52 bits). */
export function newId(length = 10): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let s = "";
  for (const b of bytes) s += ID_CHARS[b % 36];
  return s;
}

export function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Random secret (32 bytes, base64url). */
export function newToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

export async function sha256Hex(text: string): Promise<string> {
  return [...(await sha256(text))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** PKCE (S256): the challenge the app sent is the hash of the verifier it now shows. */
export async function pkceMatches(verifier: string, challenge: string): Promise<boolean> {
  return base64url(await sha256(verifier)) === challenge;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

// ── Rules ────────────────────────────────────────────────────────────────

/** Start of the Hot ranking's time axis. */
const HOT_EPOCH = 1_700_000_000;

/** Hot ranking: each 10× of score is worth 12.5 hours of age. */
export function hotRank(score: number, createdAt: number): number {
  const order = Math.log10(Math.max(Math.abs(score), 1));
  const sign = score > 0 ? 1 : score < 0 ? -1 : 0;
  return Math.round((sign * order + (createdAt - HOT_EPOCH) / 45_000) * 1e7) / 1e7;
}

export const NAME_RE = /^[A-Za-z0-9_-]{3,20}$/;

/** A user name from a sign-in profile: allowed characters only, 3 to 20 long. */
export function nameFromProfile(raw: string): string {
  let name = raw.normalize("NFKD").replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 20);
  if (name.length < 3) name = (name + "_trader").slice(0, 20);
  return name;
}

export const TICKER_RE = /^[A-Z0-9][A-Z0-9.\-]{0,14}$/;
export const THEME_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;

/** A community id: `t:AAPL` (any ticker, made on first use) or `c:penny-stocks` (themes). */
export function parseCommunityId(id: string): { kind: "ticker" | "theme"; key: string } | null {
  if (id.startsWith("t:")) {
    const key = id.slice(2).toUpperCase();
    return TICKER_RE.test(key) ? { kind: "ticker", key } : null;
  }
  if (id.startsWith("c:")) {
    const key = id.slice(2);
    return THEME_RE.test(key) ? { kind: "theme", key } : null;
  }
  return null;
}

/** Members' feature suggestions (suggestions.ts): kept out of the market feeds and search. */
export const SUGGESTIONS = "c:suggestions";
/** The project whose GitHub issues track the suggestions. */
export const GITHUB_REPO = "deepentropy/opentrader";

export const LIMITS = {
  titleMin: 3,
  titleMax: 300,
  bodyMax: 20_000,
  commentMax: 10_000,
  reportDetailsMax: 1_000,
  reasonMax: 500,
  pageSize: 25,
  commentsPerPost: 1_000,
  /** Accounts younger than a day. */
  newAccountSeconds: 86_400,
  postsPerDay: 20,
  postsPerDayNew: 3,
  commentsPerDay: 300,
  commentsPerDayNew: 30,
} as const;

/** SHA-256 of the sender's IP address and the day: daily limits per connection without keeping the address. */
export async function senderHash(request: Request): Promise<string> {
  return sha256Hex(`${request.headers.get("CF-Connecting-IP") ?? "unknown"}:${Math.floor(Date.now() / 86_400_000)}`);
}

export function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
