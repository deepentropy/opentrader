/*
 * Community API client (deploy/community): ticker communities (US stocks and
 * ETFs) and General; posts typed idea / analysis / question / post-mortem,
 * ideas with locked levels settled in R; replies; the readers' "useful"
 * reasons; reports and moderation; and the website's page views. Reading
 * needs no account; the session token (./session.ts) is sent when there is one.
 */

/** The community server; VITE_COMMUNITY_URL points a dev build at a local one. */
export const COMMUNITY_URL = ((import.meta.env.VITE_COMMUNITY_URL as string | undefined) ?? "https://community.opentrader.markets").replace(/\/+$/, "");

/** The Community tab is shown (VITE_COMMUNITY_ENABLED=0 hides it, e.g. for a self-hosted build). */
export const COMMUNITY_ENABLED = import.meta.env.VITE_COMMUNITY_ENABLED !== "0";

/** General: the posts about no one ticker. */
export const GENERAL = "c:general";

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

/** A chart shared in a post: what "Open on my chart" applies. */
export type SharedChart = { symbol: string; interval: string; drawings: unknown[] };

export type PostType = "idea" | "analysis" | "question" | "postmortem";
export type IdeaStatus = "pending" | "open" | "target" | "stopped" | "expired" | "untriggered";
export type Direction = "long" | "short";

/** An idea's levels and where it stands; result_r: final, or now while open. */
export type Idea = {
  direction: Direction;
  entry: number;
  stop: number;
  target: number;
  /** Last day it can settle (YYYY-MM-DD, New York). */
  expires: string;
  entry_rule: "close" | "touch";
  /** The price when posted: the entry triggers when price crosses it from this side. */
  ref_price: number;
  reward_risk: number;
  status: IdeaStatus;
  triggered_at: number | null;
  trigger_price: number | null;
  resolved_at: number | null;
  exit_price: number | null;
  last_price: number | null;
  result_r: number | null;
};

/** A trader's settled ideas: how many, the share that hit the target, the average R; and the open ones. */
export type TrackRecord = { resolved: number; hit_pct: number | null; avg_r: number | null; open: number };

export type Post = {
  id: string;
  type: PostType;
  community: CommunityRef;
  author: string | null;
  author_record: TrackRecord | null;
  title: string;
  body: string;
  excerpt: string;
  useful_count: number;
  flag_count: number;
  comment_count: number;
  created_at: number;
  edited_at: number | null;
  locked: boolean;
  deleted: boolean;
  removed: boolean;
  removed_reason: string | null;
  own: boolean;
  source_url: string | null;
  /** Posted by the automatic threads' account (OpenTrader-bot). */
  author_bot?: boolean;
  idea: Idea | null;
  /** A question's accepted reply. */
  answer_id: string | null;
  /** A post-mortem's idea. */
  linked: { id: string; title: string | null; status: IdeaStatus | null; result_r: number | null } | null;
  /** Shared chart (lists: symbol and interval only). */
  chart: SharedChart | null;
  has_chart: boolean;
  /** Path of the chart's picture on the community server (see imageUrl). */
  image_url: string | null;
};

/** A chart attached to a new post or reply: its state and picture (base64), or a snapshot sent from the app. */
export type ChartAttachment = { chart: SharedChart; image: string; imageType: string } | { snapshotId: string };

export type ReplyKind = "data" | "counterpoint" | "question" | "update";

export type Comment = {
  id: string;
  parent_id: string | null;
  author: string | null;
  author_record: TrackRecord | null;
  /** Written by the post's author. */
  by_op: boolean;
  kind: ReplyKind | null;
  body: string;
  useful_count: number;
  my_useful: boolean;
  created_at: number;
  edited_at: number | null;
  deleted: boolean;
  removed: boolean;
  removed_reason: string | null;
  own: boolean;
  chart: SharedChart | null;
  image_url: string | null;
};

/** Why readers found a post useful; "vague": not useful. */
export type Reason = "thesis" | "data" | "view" | "risk" | "vague";
export type Ratings = { reasons: Partial<Record<Reason, number>>; mine: Reason[] };

export type NewIdea = { direction: Direction; entry: number; stop: number; target: number; expires: string; entry_rule: "close" | "touch" };
export type NewPost = { type: PostType; title: string; body: string; idea?: NewIdea; linked_id?: string | null; attach?: ChartAttachment | null };

/** A chart snapshot sent from the app to the member's account. */
export type Snapshot = { id: string; symbol: string; interval: string; created_at: number };

export type Me = {
  user: { name: string; role: string; created_at: number; banned_until: number | null; ban_reason: string | null; post_checked: boolean; bio: string };
  moderates: string[] | "all";
  follows: CommunityRef[];
};

export type Sort = "useful" | "new";

export type HomeView = {
  since: number;
  visitor: boolean;
  posts: Post[];
  counts: Partial<Record<PostType | "all", number>>;
  resolved: number;
  my_tickers: { id: string; title: string; fresh: number }[];
  record30: TrackRecord & { hits: number; total_r: number };
  resolving: { id: string; ticker: string; direction: Direction; author: string | null; status: IdeaStatus; entry: number; stop: number; target: number; expires: string; last_price: number | null }[];
  open_questions: { id: string; title: string; created_at: number; comment_count: number }[];
};

export type Quote = { last: number; change: number | null; change_pct: number | null };
export type TickerView = {
  community: { id: string; title: string; post_count: number; followed: boolean };
  ticker: string;
  reference: { name: string; exchange: string; sector: string; type: string } | null;
  quote: Quote | null;
  open_ideas: { id: string; title: string; author: string | null; author_record: TrackRecord | null; created_at: number; idea: Idea }[];
  positioning: { long: number; short: number; weighted_long_pct: number | null };
  resolved90: TrackRecord & { recent: { id: string; direction: Direction; status: IdeaStatus; result_r: number; resolved_at: number; author: string | null }[] };
  answered: { id: string; title: string; useful_count: number; answer_by: string | null }[];
};
export type Bar = { time: number; open: number; high: number; low: number; close: number };
export type TickerRow = { id: string; title: string; posts30: number; open_ideas: number };

export type SearchResult = Post & { snippet: string };
export type SearchFacets = {
  type: Partial<Record<PostType, number>>;
  outcome: Partial<Record<"target" | "stopped" | "expired" | "open", number>>;
  posted: { week: number; "90d": number; any: number };
};
export type SearchView = { total: number; facets: SearchFacets; results: SearchResult[]; next_offset: number | null };
export type SearchFilters = { types: PostType[]; outcomes: string[]; posted: "week" | "90d" | "any"; minUseful: number };

export type Profile = {
  user: { name: string; bio: string; created_at: number; bot: boolean };
  record: TrackRecord & { hits: number; total_r: number };
  median_hold_days: number | null;
  first_resolved_at: number | null;
  curve: { at: number; r: number; result: number }[];
  outcomes: { target: number; stopped: number; expired: number };
  counts: Partial<Record<PostType | "replies", number>>;
  reasons: { reason: Reason; n: number }[];
  by_direction: (TrackRecord & { direction: Direction })[];
  tickers: { ticker: string; n: number }[];
  watching: boolean;
  own: boolean;
};
export type ProfileReply = { id: string; post_id: string; body: string; kind: ReplyKind | null; useful_count: number; created_at: number; post_title: string; community_id: string };

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
  /** `data`: the error answer's other fields (`check: true`: the bot check is needed first). */
  constructor(public status: number, message: string, public data: Record<string, unknown> = {}) {
    super(message);
  }
}

/** A notification: a reply, a moderation decision, a new idea from a watched trader. */
export type Notice = {
  id: string;
  kind: "reply" | "removed" | "banned" | "proposal" | "idea";
  post_id: string | null;
  comment_id: string | null;
  actor: string | null;
  text: string;
  created_at: number;
  read_at: number | null;
  post_title: string | null;
};

/** A line of a community's public moderation log. */
export type LogEntry = { action: string; target_type: string; reason: string; created_at: number; post_id: string | null; post_title: string | null };
export type CommunityBan = { name: string; until: number; reason: string; created_at: number };

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
    request<{ posts: Post[]; next_offset: number | null }>("GET", `/users/${enc(name)}/posts?${qs({ type, offset, limit })}`),
  userReplies: (name: string, offset = 0) => request<{ replies: ProfileReply[]; next_offset: number | null }>("GET", `/users/${enc(name)}/replies?offset=${offset}`),
  watch: (name: string, on: boolean) => request<{ watching: boolean }>(on ? "POST" : "DELETE", `/users/${enc(name)}/watch`),

  community: (id: string) => request<{ community: Community }>("GET", `/communities/${enc(id)}`),
  follow: (id: string, on: boolean) => request<{ ok: true }>(on ? "POST" : "DELETE", `/communities/${enc(id)}/follow`),
  posts: (id: string, sort: Sort, offset = 0, type: PostType | null = null) =>
    request<{ posts: Post[]; next_offset: number | null }>("GET", `/communities/${enc(id)}/posts?${qs({ sort, offset, type })}`),
  feed: (scope: "following" | "all", sort: Sort, offset = 0, type: PostType | null = null) =>
    request<{ posts: Post[]; next_offset: number | null }>("GET", `/feed?${qs({ scope, sort, offset, type })}`),
  createPost: (id: string, p: NewPost) =>
    request<{ post: Post; comments: Comment[]; ratings: Ratings }>("POST", `/communities/${enc(id)}/posts`, {
      type: p.type,
      title: p.title,
      body: p.body,
      idea: p.idea,
      linked_id: p.linked_id ?? undefined,
      ...attachBody(p.attach),
    }),

  post: (id: string) => request<{ post: Post; comments: Comment[]; ratings: Ratings; is_mod: boolean }>("GET", `/posts/${enc(id)}`),
  editPost: (id: string, body: string) => request<{ post: Post; comments: Comment[]; ratings: Ratings }>("PATCH", `/posts/${enc(id)}`, { body }),
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
  modAction: (action: string, type: "post" | "comment" | "user", id: string, reason = "", days?: number) =>
    request<{ ok: true }>("POST", "/mod/action", { action, target_type: type, target_id: id, reason, days }),
};
