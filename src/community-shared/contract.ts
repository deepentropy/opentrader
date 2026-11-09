/*
 * The community API's contract: what the server (deploy/community) answers and
 * accepts, typed once for the server, the app's Community panel and the
 * website. The server's bundle imports this file too, so it holds types and
 * plain lists only: no app or browser code.
 */

// ── Words ───────────────────────────────────────────────────────────────

/** The market posts' types, the ones a member picks (suggestions are posted on their own page). */
export const POST_TYPES = ["idea", "analysis", "question", "postmortem"] as const;
export type PostType = (typeof POST_TYPES)[number] | "suggestion";

export type Direction = "long" | "short";
/** An idea's entry triggers on a daily close through it, or on a trade through it. */
export type EntryRule = "close" | "touch";
export type IdeaStatus = "pending" | "open" | "target" | "stopped" | "expired" | "untriggered";

export const SUGGESTION_STATUSES = ["review", "planned", "progress", "shipped", "declined"] as const;
export type SuggestionStatus = (typeof SUGGESTION_STATUSES)[number];

/** A reply's kind; 'update': by the post's author; 'support': why a supporter needs a suggestion. */
export const REPLY_KINDS = ["data", "counterpoint", "question", "update", "support"] as const;
export type ReplyKind = (typeof REPLY_KINDS)[number];

/** Why readers found a post useful; "vague": not useful. */
export const REASONS = ["thesis", "data", "view", "risk", "vague"] as const;
export type Reason = (typeof REASONS)[number];

export const REPORT_REASONS = ["spam", "manipulation", "harassment", "illegal", "other"] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];
/** Queue entries also hold the authors' appeals against a removal. */
export type QueueReason = ReportReason | "appeal";

export const CONTACT_KINDS = ["illegal", "appeal", "authority", "other"] as const;
export type ContactKind = (typeof CONTACT_KINDS)[number];

export type NoticeKind = "reply" | "removed" | "banned" | "proposal" | "idea" | "status";

export type CommunityKind = "ticker" | "theme";

// ── Shapes ──────────────────────────────────────────────────────────────

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

/** An idea's levels and where it stands; result_r: final, or now while open. */
export type Idea = {
  direction: Direction;
  entry: number;
  stop: number;
  target: number;
  /** Last day it can settle (YYYY-MM-DD, New York). */
  expires: string;
  entry_rule: EntryRule;
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

/** A suggestion's status, the administrators' note, its GitHub issue; external_author: brought in from GitHub, by this login. */
export type Suggestion = {
  status: SuggestionStatus;
  note: string | null;
  updated_at: number | null;
  issue_number: number | null;
  issue_url: string | null;
  external_author: string | null;
};

/** A trader's settled ideas: how many, the share that hit the target, the average R; and the open ones. */
export type TrackRecord = { resolved: number; hit_pct: number | null; avg_r: number | null; open: number };
/** A track record with its counts behind it: the targets hit, the R summed. */
export type RecordTotals = TrackRecord & { hits: number; total_r: number };

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
  /** "journal": trades from the author's trade journal, self-reported (never in a track record). */
  origin?: "journal" | null;
  /** Posted by the automatic threads' account (OpenTrader-bot). */
  author_bot?: boolean;
  idea: Idea | null;
  /** A suggestion's status and issue (useful_count: its supporters). */
  suggestion?: Suggestion | null;
  /** A question's accepted reply. */
  answer_id: string | null;
  /** A post-mortem's idea. */
  linked: { id: string; title: string | null; status: IdeaStatus | null; result_r: number | null } | null;
  /** Shared chart (lists: symbol and interval only). */
  chart: SharedChart | null;
  has_chart: boolean;
  /** Path of the chart's picture on the community server. */
  image_url: string | null;
};

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

export type Ratings = { reasons: Partial<Record<Reason, number>>; mine: Reason[] };

/** A post with its replies (the client builds the tree) and the viewer's ratings. */
export type PostThread = { post: Post; comments: Comment[]; ratings: Ratings };
/** GET /posts/:id; supported: a suggestion the viewer supports. */
export type PostDetail = PostThread & { is_mod: boolean; supported?: boolean };
/** A page of a post list. */
export type PostList = { posts: Post[]; next_offset: number | null };

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
  record30: RecordTotals;
  resolving: { id: string; ticker: string; direction: Direction; author: string | null; status: IdeaStatus; entry: number; stop: number; target: number; expires: string; last_price: number | null }[];
  open_questions: { id: string; title: string; created_at: number; comment_count: number }[];
  /** The side box: the most supported open suggestions, and those shipped in the last 30 days. */
  suggestions?: Record<"open" | "shipped", { id: string; title: string; status: SuggestionStatus; supporters: number }[]>;
};

export type Quote = { last: number; change: number | null; change_pct: number | null };
/** The company behind a ticker. */
export type TickerReference = { name: string; exchange: string; sector: string; type: string };
export type TickerView = {
  community: { id: string; title: string; post_count: number; followed: boolean };
  ticker: string;
  reference: TickerReference | null;
  quote: Quote | null;
  open_ideas: { id: string; title: string; author: string | null; author_record: TrackRecord | null; created_at: number; idea: Idea }[];
  positioning: { long: number; short: number; weighted_long_pct: number | null };
  resolved90: RecordTotals & { recent: { id: string; direction: Direction; status: IdeaStatus; result_r: number; resolved_at: number; author: string | null }[] };
  answered: { id: string; title: string; useful_count: number; answer_by: string | null }[];
};
export type Bar = { time: number; open: number; high: number; low: number; close: number };
export type TickerRow = { id: string; title: string; posts30: number; open_ideas: number };

/** A search query read in words: `$NVDA`, `type:post-mortem`, `outcome:stopped`, `by:name`, and text. */
export type SearchQuery = { terms: string[]; ticker: string | null; types: string[]; outcomes: string[]; author: string | null };
export type SearchResult = Post & { snippet: string };
export type SearchFacets = {
  type: Partial<Record<PostType, number>>;
  outcome: Partial<Record<"target" | "stopped" | "expired" | "open", number>>;
  posted: { week: number; "90d": number; any: number };
};
export type SearchView = { query: SearchQuery; total: number; facets: SearchFacets; results: SearchResult[]; next_offset: number | null };

export type Profile = {
  user: { name: string; bio: string; created_at: number; bot: boolean };
  record: RecordTotals;
  median_hold_days: number | null;
  first_resolved_at: number | null;
  curve: { at: number; r: number; result: number }[];
  outcomes: { target: number; stopped: number; expired: number };
  counts: Partial<Record<PostType | "replies", number>>;
  reasons: { reason: Reason; n: number }[];
  by_direction: (RecordTotals & { direction: Direction })[];
  tickers: { ticker: string; n: number }[];
  watching: boolean;
  own: boolean;
};
export type ProfileReply = { id: string; post_id: string; body: string; kind: ReplyKind | null; useful_count: number; created_at: number; post_title: string; community_id: string };

export type SuggestionsView = {
  suggestions: Post[];
  /** Ids of the listed suggestions the viewer supports. */
  supported: string[];
  counts: Partial<Record<SuggestionStatus | "open" | "all", number>>;
  next_offset: number | null;
};

/** A message sent through the website's contact form (administrators). */
export type ContactMessage = { id: string; kind: ContactKind; email: string | null; url: string; body: string; created_at: number; user_name: string | null };

export type QueueItem = {
  target_type: "post" | "comment";
  target_id: string;
  community_id: string;
  reports: number;
  first_at: number;
  content: { id: string; post_id?: string; title?: string; body: string; removed: number; locked?: number; author: string | null } | null;
  reasons: { reason: QueueReason; details: string; created_at: number }[];
};

/** A notification: a reply, a moderation decision, a new idea from a watched trader. */
export type Notice = {
  id: string;
  kind: NoticeKind;
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
