-- #219: the bot check before a new account's first posts. Accounts made
-- before it are taken as checked.
ALTER TABLE users ADD COLUMN post_checked INTEGER NOT NULL DEFAULT 0;
UPDATE users SET post_checked = 1;
CREATE TABLE post_checks (
  ticket TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);

-- #208: notifications (replies, moderation decisions, proposals).
CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 'reply' | 'removed' | 'banned' | 'proposal'
  kind TEXT NOT NULL,
  post_id TEXT,
  comment_id TEXT,
  actor TEXT,
  text TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  read_at INTEGER
);
CREATE INDEX notifications_user ON notifications(user_id, created_at DESC);
CREATE INDEX notifications_unread ON notifications(user_id, read_at);

-- #209: bans from one community, by its moderators.
CREATE TABLE community_bans (
  community_id TEXT NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  until INTEGER NOT NULL,
  reason TEXT NOT NULL,
  banned_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (community_id, user_id)
);

-- #209: theme communities proposed by members, decided by administrators.
CREATE TABLE community_proposals (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  proposer_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'approved' | 'rejected'
  reason TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  decided_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  decided_at INTEGER
);
CREATE INDEX community_proposals_status ON community_proposals(status, created_at);
