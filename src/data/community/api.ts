/*
 * Community API client (deploy/community): ticker communities (US stocks and
 * ETFs) and General; posts typed idea / analysis / question / post-mortem,
 * ideas with locked levels settled in R; replies; the readers' "useful"
 * reasons; members' feature suggestions; reports and moderation; and the
 * website's page views. Reading
 * needs no account; the session token (./session.ts) is sent when there is one.
 */

import type {
  Bar, Comment, Community, CommunityBan, ContactKind, ContactMessage, Direction, EntryRule, HomeView, LogEntry, Me, Notice, Post, PostDetail, PostList,
  PostThread, PostType, Profile, ProfileReply, QueueItem, Ratings, Reason, ReplyKind, ReportReason, SearchView, SharedChart, Snapshot, Sort, SuggestionStatus,
  SuggestionsView, TickerRow, TickerView,
} from "../../community-shared/contract";

/** The community server; VITE_COMMUNITY_URL points a dev build at a local one. */
export const COMMUNITY_URL = ((import.meta.env.VITE_COMMUNITY_URL as string | undefined) ?? "https://community.opentrader.markets").replace(/\/+$/, "");

/** The Community tab is shown (VITE_COMMUNITY_ENABLED=0 hides it, e.g. for a self-hosted build). */
export const COMMUNITY_ENABLED = import.meta.env.VITE_COMMUNITY_ENABLED !== "0";

/** General: the posts about no one ticker. */
export const GENERAL = "c:general";
/** Members' feature suggestions (their own page on the website). */
export const SUGGESTIONS = "c:suggestions";

// The server's answers, typed once for the server and its clients.
export type * from "../../community-shared/contract";

/** A chart attached to a new post or reply: its state and picture (base64), or a snapshot sent from the app. */
export type ChartAttachment = { chart: SharedChart; image: string; imageType: string } | { snapshotId: string };

export type NewIdea = { direction: Direction; entry: number; stop: number; target: number; expires: string; entry_rule: EntryRule };
export type NewPost = {
  type: PostType;
  title: string;
  body: string;
  idea?: NewIdea;
  linked_id?: string | null;
  attach?: ChartAttachment | null;
  /** "journal": trades shared from the trade journal (labelled self-reported). */
  origin?: "journal";
};

export type SearchFilters = { types: PostType[]; outcomes: string[]; posted: "week" | "90d" | "any"; minUseful: number };
export type SuggestionFilter = SuggestionStatus | "open" | "all";

export class CommunityError extends Error {
  /** `data`: the error answer's other fields (`check: true`: the bot check is needed first). */
  constructor(public status: number, message: string, public data: Record<string, unknown> = {}) {
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
    throw new CommunityError(res.status, (data as { error?: string }).error ?? `Error ${res.status}`, data as Record<string, unknown>);
  }
  return data as T;
}

const enc = encodeURIComponent;

/** Full address of a picture path the server gives. */
export function imageUrl(path: string): string {
  return /^https?:/.test(path) ? path : COMMUNITY_URL + path;
}

/** `t:AAPL` for a chart symbol (`NASDAQ:AAPL`, `AAPL`), or null when it can't be a community. */
export function tickerCommunityId(ticker: string): string | null {
  const t = ticker.trim().toUpperCase();
  return /^[A-Z0-9][A-Z0-9.\-]{0,14}$/.test(t) ? `t:${t}` : null;
}

const attachBody = (a?: ChartAttachment | null) =>
  !a ? {} : "snapshotId" in a ? { snapshot_id: a.snapshotId } : { chart: a.chart, image: a.image, image_type: a.imageType };

const qs = (o: Record<string, string | number | null | undefined>) =>
  Object.entries(o)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${enc(String(v))}`)
    .join("&");

export const api = {
  providers: () => request<{ providers: string[] }>("GET", "/auth/providers"),
  me: () => request<Me>("GET", "/me"),
  updateMe: (fields: { name?: string; bio?: string }) => request<Me>("PATCH", "/me", fields),
  rename: (name: string) => request<Me>("PATCH", "/me", { name }),
  deleteAccount: () => request<{ ok: true }>("DELETE", "/me"),
  logout: () => request<{ ok: true }>("POST", "/auth/logout"),
  setTickers: (tickers: string[]) => request<Me>("PUT", "/me/tickers", { tickers }),
  snapshots: () => request<{ snapshots: Snapshot[] }>("GET", "/me/snapshots"),
  addSnapshot: (chart: SharedChart, image: string, imageType: string) => request<{ snapshot: Snapshot }>("POST", "/me/snapshots", { chart, image, image_type: imageType }),
  deleteSnapshot: (id: string) => request<{ ok: true }>("DELETE", `/me/snapshots/${enc(id)}`),
  /** A snapshot's picture (private: fetched with the session), as an object URL. */
  snapshotImage: async (id: string): Promise<string> => {
    const res = await fetch(`${COMMUNITY_URL}/me/snapshots/${enc(id)}/image`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    if (!res.ok) throw new CommunityError(res.status, "The snapshot's picture is unavailable.");
    return URL.createObjectURL(await res.blob());
  },

  home: (sort: Sort, type: PostType | null) => request<HomeView>("GET", `/home?${qs({ sort, type })}`),
  ticker: (ticker: string) => request<TickerView>("GET", `/tickers/${enc(ticker)}`),
  tickerBars: (ticker: string) => request<{ bars: Bar[] }>("GET", `/tickers/${enc(ticker)}/bars`),
  tickers: () => request<{ mine: TickerRow[]; active: TickerRow[] }>("GET", "/tickers"),
  popularTickers: () => request<{ tickers: { id: string; title: string; post_count: number }[] }>("GET", "/tickers/popular"),
  search: (q: string, f: SearchFilters, offset = 0) =>
    request<SearchView>("GET", `/search?${qs({ q, type: f.types.join(","), outcome: f.outcomes.join(","), posted: f.posted, min_useful: f.minUseful || null, offset: offset || null })}`),
  profile: (name: string) => request<Profile>("GET", `/users/${enc(name)}`),
  userPosts: (name: string, type: PostType, offset = 0, limit = 8) =>
    request<PostList>("GET", `/users/${enc(name)}/posts?${qs({ type, offset, limit })}`),
  userReplies: (name: string, offset = 0) => request<{ replies: ProfileReply[]; next_offset: number | null }>("GET", `/users/${enc(name)}/replies?offset=${offset}`),
  watch: (name: string, on: boolean) => request<{ watching: boolean }>(on ? "POST" : "DELETE", `/users/${enc(name)}/watch`),

  community: (id: string) => request<{ community: Community }>("GET", `/communities/${enc(id)}`),
  follow: (id: string, on: boolean) => request<{ ok: true }>(on ? "POST" : "DELETE", `/communities/${enc(id)}/follow`),
  posts: (id: string, sort: Sort, offset = 0, type: PostType | null = null) =>
    request<PostList>("GET", `/communities/${enc(id)}/posts?${qs({ sort, offset, type })}`),
  feed: (scope: "following" | "all", sort: Sort, offset = 0, type: PostType | null = null) =>
    request<PostList>("GET", `/feed?${qs({ scope, sort, offset, type })}`),
  createPost: (id: string, p: NewPost) =>
    request<PostThread>("POST", `/communities/${enc(id)}/posts`, {
      type: p.type,
      title: p.title,
      body: p.body,
      idea: p.idea,
      linked_id: p.linked_id ?? undefined,
      origin: p.origin,
      ...attachBody(p.attach),
    }),

  /** supported: a suggestion the viewer supports. */
  post: (id: string) => request<PostDetail>("GET", `/posts/${enc(id)}`),
  editPost: (id: string, body: string) => request<PostThread>("PATCH", `/posts/${enc(id)}`, { body }),
  deletePost: (id: string) => request<{ ok: true }>("DELETE", `/posts/${enc(id)}`),
  rate: (id: string, reason: Reason, on: boolean) => request<{ useful_count: number; flag_count: number } & Ratings>("POST", `/posts/${enc(id)}/rate`, { reason, on }),
  markAnswer: (id: string, commentId: string | null) => request<{ answer_id: string | null }>("POST", `/posts/${enc(id)}/answer`, { comment_id: commentId }),
  comment: (postId: string, body: string, parentId: string | null, kind: ReplyKind | null = null, attach: ChartAttachment | null = null) =>
    request<{ comment: Comment }>("POST", `/posts/${enc(postId)}/comments`, { body, parent_id: parentId, kind, ...attachBody(attach) }),
  editComment: (id: string, body: string) => request<{ comment: Comment }>("PATCH", `/comments/${enc(id)}`, { body }),
  deleteComment: (id: string) => request<{ ok: true }>("DELETE", `/comments/${enc(id)}`),
  useful: (id: string, on: boolean) => request<{ useful_count: number; my_useful: boolean }>("POST", `/comments/${enc(id)}/useful`, { on }),

  report: (type: "post" | "comment", id: string, reason: ReportReason, details: string) =>
    request<{ ok: true }>("POST", "/reports", { target_type: type, target_id: id, reason, details }),
  appeal: (type: "post" | "comment", id: string, details: string) => request<{ ok: true }>("POST", "/appeals", { target_type: type, target_id: id, details }),
  contact: (kind: ContactKind, email: string, url: string, body: string) => request<{ ok: true }>("POST", "/contact", { kind, email, url, body }),
  queue: () => request<{ items: QueueItem[] }>("GET", "/mod/queue"),
  checkStart: () => request<{ url: string }>("POST", "/check/start"),
  unread: () => request<{ unread: number }>("GET", "/me/unread"),
  notifications: () => request<{ notifications: Notice[] }>("GET", "/me/notifications"),
  markRead: () => request<{ ok: true }>("POST", "/me/notifications/read"),
  moderators: (id: string) => request<{ moderators: string[] }>("GET", `/communities/${enc(id)}/moderators`),
  communityLog: (id: string) => request<{ actions: LogEntry[] }>("GET", `/communities/${enc(id)}/log`),
  bans: (id: string) => request<{ bans: CommunityBan[] }>("GET", `/communities/${enc(id)}/bans`),
  communityBan: (id: string, name: string, ban: boolean, days = 0, reason = "") =>
    request<{ ok: true }>("POST", "/mod/community-ban", { community_id: id, name, ban, days, reason }),
  setModerator: (id: string, name: string, add: boolean) => request<{ ok: true }>("POST", "/mod/moderators", { community_id: id, name, add }),
  messages: () => request<{ messages: ContactMessage[] }>("GET", "/mod/messages"),
  messageDone: (id: string) => request<{ ok: true }>("POST", `/mod/messages/${enc(id)}/done`),
  suggestions: (status: SuggestionFilter, sort: "top" | "new", q = "", offset = 0) =>
    request<SuggestionsView>("GET", `/suggestions?${qs({ status, sort, q, offset: offset || null })}`),
  suggest: (title: string, body: string) => request<{ post: Post }>("POST", "/suggestions", { title, body }),
  support: (id: string, on: boolean, why = "") => request<{ supporters: number; supported: boolean; comment: Comment | null }>("POST", `/suggestions/${enc(id)}/support`, { on, why }),
  setSuggestion: (id: string, fields: { status?: SuggestionStatus; note?: string; issue_number?: number | null }) =>
    request<{ post: Post }>("POST", `/mod/suggestions/${enc(id)}`, fields),
  /** A 501 error without a GitHub token on the server: its `new_issue_url` opens a prefilled issue. */
  promoteSuggestion: (id: string) => request<{ post: Post }>("POST", `/mod/suggestions/${enc(id)}/promote`),
  importIssue: (issue: number) => request<{ post: Post }>("POST", "/mod/suggestions/import", { issue }),
  modAction: (action: string, type: "post" | "comment" | "user", id: string, reason = "", days?: number) =>
    request<{ ok: true }>("POST", "/mod/action", { action, target_type: type, target_id: id, reason, days }),
};
