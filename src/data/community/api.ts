/*
 * Community API client (deploy/community): ticker communities ($AAPL), theme
 * communities, posts, comments, votes, reports and moderation. Reading needs
 * no account; the session token (./session.ts) is sent when there is one.
 */

/** The community server; VITE_COMMUNITY_URL points a dev build at a local one. */
export const COMMUNITY_URL = ((import.meta.env.VITE_COMMUNITY_URL as string | undefined) ?? "https://community.opentrader.markets").replace(/\/+$/, "");

/** The Community tab is shown (VITE_COMMUNITY_ENABLED=0 hides it, e.g. for a self-hosted build). */
export const COMMUNITY_ENABLED = import.meta.env.VITE_COMMUNITY_ENABLED !== "0";

export type CommunityKind = "ticker" | "theme";

export type Community = {
  id: string;
  kind: CommunityKind;
  title: string;
  description: string;
  post_count: number;
  min_account_days: number;
  followed: boolean;
  is_mod: boolean;
};

export type CommunityRef = { id: string; kind: CommunityKind; title: string };

export type Post = {
  id: string;
  community: CommunityRef;
  author: string | null;
  title: string;
  body: string;
  excerpt: string;
  score: number;
  comment_count: number;
  created_at: number;
  edited_at: number | null;
  locked: boolean;
  deleted: boolean;
  removed: boolean;
  removed_reason: string | null;
  my_vote: number;
  own: boolean;
  source_url: string | null;
};

export type Comment = {
  id: string;
  parent_id: string | null;
  author: string | null;
  body: string;
  score: number;
  created_at: number;
  edited_at: number | null;
  deleted: boolean;
  removed: boolean;
  removed_reason: string | null;
  my_vote: number;
  own: boolean;
};

export type Me = {
  user: { name: string; role: string; created_at: number; banned_until: number | null; ban_reason: string | null };
  moderates: string[] | "all";
  follows: CommunityRef[];
};

export type Sort = "hot" | "new" | "top";
export type ContactKind = "illegal" | "appeal" | "authority" | "other";

/** A message sent through the website's contact form (administrators). */
export type ContactMessage = { id: string; kind: ContactKind; email: string | null; url: string; body: string; created_at: number; user_name: string | null };
export type ReportReason = "spam" | "manipulation" | "harassment" | "illegal" | "other";
/** Queue entries also hold the authors' appeals against a removal. */
export type QueueReason = ReportReason | "appeal";

export type QueueItem = {
  target_type: "post" | "comment";
  target_id: string;
  community_id: string;
  reports: number;
  first_at: number;
  content: { id: string; post_id?: string; title?: string; body: string; removed: number; locked?: number; author: string | null } | null;
  reasons: { reason: QueueReason; details: string; created_at: number }[];
};

export class CommunityError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

let token: string | null = null;
/** Set by the session (./session.ts). */
export function setApiToken(t: string | null): void {
  token = t;
}
/** Called when the server no longer knows the session. */
let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

export async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(COMMUNITY_URL + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new CommunityError(0, "Community is unreachable. Check your connection.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && token) onUnauthorized();
    throw new CommunityError(res.status, (data as { error?: string }).error ?? `Error ${res.status}`);
  }
  return data as T;
}

const enc = encodeURIComponent;

/** `t:AAPL` for a chart symbol (`NASDAQ:AAPL`, `AAPL`), or null when it can't be a community. */
export function tickerCommunityId(ticker: string): string | null {
  const t = ticker.trim().toUpperCase();
  return /^[A-Z0-9][A-Z0-9.\-]{0,14}$/.test(t) ? `t:${t}` : null;
}

export const api = {
  providers: () => request<{ providers: string[] }>("GET", "/auth/providers"),
  me: () => request<Me>("GET", "/me"),
  rename: (name: string) => request<Me>("PATCH", "/me", { name }),
  deleteAccount: () => request<{ ok: true }>("DELETE", "/me"),
  logout: () => request<{ ok: true }>("POST", "/auth/logout"),

  themes: () => request<{ communities: Community[] }>("GET", "/communities"),
  community: (id: string) => request<{ community: Community }>("GET", `/communities/${enc(id)}`),
  follow: (id: string, on: boolean) => request<{ ok: true }>(on ? "POST" : "DELETE", `/communities/${enc(id)}/follow`),
  posts: (id: string, sort: Sort, offset = 0, t = "week") =>
    request<{ posts: Post[]; next_offset: number | null }>("GET", `/communities/${enc(id)}/posts?sort=${sort}&t=${t}&offset=${offset}`),
  feed: (scope: "following" | "all", sort: Sort, offset = 0, t = "week") =>
    request<{ posts: Post[]; next_offset: number | null }>("GET", `/feed?scope=${scope}&sort=${sort}&t=${t}&offset=${offset}`),
  createPost: (id: string, title: string, body: string) => request<{ post: Post; comments: Comment[] }>("POST", `/communities/${enc(id)}/posts`, { title, body }),

  post: (id: string) => request<{ post: Post; comments: Comment[]; is_mod: boolean }>("GET", `/posts/${enc(id)}`),
  editPost: (id: string, body: string) => request<{ post: Post; comments: Comment[] }>("PATCH", `/posts/${enc(id)}`, { body }),
  deletePost: (id: string) => request<{ ok: true }>("DELETE", `/posts/${enc(id)}`),
  comment: (postId: string, body: string, parentId: string | null) => request<{ comment: Comment }>("POST", `/posts/${enc(postId)}/comments`, { body, parent_id: parentId }),
  editComment: (id: string, body: string) => request<{ comment: Comment }>("PATCH", `/comments/${enc(id)}`, { body }),
  deleteComment: (id: string) => request<{ ok: true }>("DELETE", `/comments/${enc(id)}`),
  vote: (type: "post" | "comment", id: string, value: number) => request<{ score: number; my_vote: number }>("POST", `/${type}s/${enc(id)}/vote`, { value }),

  report: (type: "post" | "comment", id: string, reason: ReportReason, details: string) =>
    request<{ ok: true }>("POST", "/reports", { target_type: type, target_id: id, reason, details }),
  appeal: (type: "post" | "comment", id: string, details: string) => request<{ ok: true }>("POST", "/appeals", { target_type: type, target_id: id, details }),
  contact: (kind: ContactKind, email: string, url: string, body: string) => request<{ ok: true }>("POST", "/contact", { kind, email, url, body }),
  queue: () => request<{ items: QueueItem[] }>("GET", "/mod/queue"),
  messages: () => request<{ messages: ContactMessage[] }>("GET", "/mod/messages"),
  messageDone: (id: string) => request<{ ok: true }>("POST", `/mod/messages/${enc(id)}/done`),
  modAction: (action: string, type: "post" | "comment" | "user", id: string, reason = "", days?: number) =>
    request<{ ok: true }>("POST", "/mod/action", { action, target_type: type, target_id: id, reason, days }),
};
