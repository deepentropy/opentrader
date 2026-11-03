-- Community: ticker communities ($AAPL), theme communities (c/penny-stocks),
-- posts, threaded comments, votes, reports and the moderation log.
-- Times are UNIX seconds.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  -- Shown name, unique without regard to case.
  name TEXT NOT NULL,
  name_key TEXT NOT NULL UNIQUE,
  -- Sign-in identity: 'github' | 'google' | 'discord' | 'dev'; 'import' for test content.
  provider TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user', -- 'user' | 'admin'
  created_at INTEGER NOT NULL,
  banned_until INTEGER, -- NULL: not banned
  ban_reason TEXT,
  UNIQUE (provider, provider_id)
);

CREATE TABLE sessions (
  -- SHA-256 of the token (hex): a database leak gives no usable token.
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

-- A sign-in in progress: started by the app with a PKCE challenge, finished
-- when the app trades the one-time code and its verifier for a session.
CREATE TABLE logins (
  state TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  challenge TEXT NOT NULL,
  redirect TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  code TEXT UNIQUE,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE communities (
  -- 't:AAPL' (ticker) or 'c:penny-stocks' (theme).
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL, -- 'ticker' | 'theme'
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  -- Account age needed to post (days).
  min_account_days INTEGER NOT NULL DEFAULT 0,
  post_count INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE moderators (
  community_id TEXT NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (community_id, user_id)
);

CREATE TABLE follows (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  community_id TEXT NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, community_id)
);

CREATE TABLE posts (
  id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL REFERENCES communities(id),
  -- NULL once the author deleted their account.
  author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  score INTEGER NOT NULL DEFAULT 0,
  comment_count INTEGER NOT NULL DEFAULT 0,
  -- Ranking for the Hot sort, updated with each vote.
  hot REAL NOT NULL,
  created_at INTEGER NOT NULL,
  edited_at INTEGER,
  deleted INTEGER NOT NULL DEFAULT 0, -- by its author
  removed INTEGER NOT NULL DEFAULT 0, -- by a moderator
  removed_reason TEXT,
  locked INTEGER NOT NULL DEFAULT 0,
  -- Imported test content: where it came from.
  source_url TEXT
);
CREATE INDEX posts_hot ON posts(community_id, hot DESC);
CREATE INDEX posts_new ON posts(community_id, created_at DESC);
CREATE INDEX posts_top ON posts(community_id, score DESC);
CREATE INDEX posts_author ON posts(author_id, created_at DESC);

CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES comments(id) ON DELETE CASCADE,
  author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  score INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  edited_at INTEGER,
  deleted INTEGER NOT NULL DEFAULT 0,
  removed INTEGER NOT NULL DEFAULT 0,
  removed_reason TEXT
);
CREATE INDEX comments_post ON comments(post_id, created_at);
CREATE INDEX comments_author ON comments(author_id, created_at DESC);

CREATE TABLE votes (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL, -- 'post' | 'comment'
  target_id TEXT NOT NULL,
  value INTEGER NOT NULL, -- 1 | -1
  PRIMARY KEY (user_id, target_type, target_id)
);

CREATE TABLE reports (
  id TEXT PRIMARY KEY,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  community_id TEXT NOT NULL,
  -- NULL: the reporter deleted their account (the report stays).
  reporter_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  reason TEXT NOT NULL, -- 'spam' | 'manipulation' | 'harassment' | 'illegal' | 'other'
  details TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open', -- 'open' | 'actioned' | 'dismissed'
  created_at INTEGER NOT NULL,
  resolved_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  resolved_at INTEGER,
  UNIQUE (reporter_id, target_type, target_id)
);
CREATE INDEX reports_open ON reports(status, community_id, created_at);

-- Each moderation decision with its reason (shown to the author).
CREATE TABLE mod_actions (
  id TEXT PRIMARY KEY,
  moderator_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL, -- 'remove' | 'restore' | 'lock' | 'unlock' | 'dismiss' | 'ban' | 'unban'
  target_type TEXT NOT NULL, -- 'post' | 'comment' | 'user'
  target_id TEXT NOT NULL,
  community_id TEXT,
  reason TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX mod_actions_community ON mod_actions(community_id, created_at DESC);

INSERT INTO communities (id, kind, title, description, min_account_days, sort_order, created_at) VALUES
  ('c:general', 'theme', 'General', 'Markets, ideas and questions that fit nowhere else.', 0, 1, unixepoch()),
  ('c:penny-stocks', 'theme', 'Penny Stocks', 'Small caps and stocks under $5. High risk: do your own research, and report promotion.', 3, 2, unixepoch()),
  ('c:options', 'theme', 'Options', 'Options strategies, trades and questions.', 0, 3, unixepoch()),
  ('c:day-trading', 'theme', 'Day Trading', 'Intraday setups, execution and risk.', 0, 4, unixepoch()),
  ('c:earnings', 'theme', 'Earnings', 'Earnings reports, previews and reactions.', 0, 5, unixepoch()),
  ('c:technical-analysis', 'theme', 'Technical Analysis', 'Chart patterns, indicators and scripts.', 0, 6, unixepoch()),
  ('c:crypto', 'theme', 'Crypto', 'Cryptocurrencies and digital assets.', 0, 7, unixepoch()),
  ('c:etfs', 'theme', 'ETFs', 'Funds, indexes and long-term investing.', 0, 8, unixepoch());
