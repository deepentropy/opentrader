-- The track-record community: every post has a type; ideas carry locked
-- levels and settle against price in R; readers say why a post was useful
-- instead of voting; tickers (US stocks) and General only.

-- 'idea' | 'analysis' | 'question' | 'postmortem'
ALTER TABLE posts ADD COLUMN type TEXT NOT NULL DEFAULT 'analysis';
-- Ideas: 'long' | 'short', the levels, the last day it can settle (YYYY-MM-DD,
-- New York), and how the entry triggers: 'close' (a daily close through it)
-- or 'touch' (a trade through it).
ALTER TABLE posts ADD COLUMN direction TEXT;
ALTER TABLE posts ADD COLUMN entry REAL;
ALTER TABLE posts ADD COLUMN stop REAL;
ALTER TABLE posts ADD COLUMN target REAL;
ALTER TABLE posts ADD COLUMN expires TEXT;
ALTER TABLE posts ADD COLUMN entry_rule TEXT;
-- The price when posted: which side of the entry the price comes from.
ALTER TABLE posts ADD COLUMN ref_price REAL;
-- 'pending' (not triggered) | 'open' | 'target' | 'stopped' | 'expired' | 'untriggered'
ALTER TABLE posts ADD COLUMN status TEXT;
ALTER TABLE posts ADD COLUMN triggered_at INTEGER;
ALTER TABLE posts ADD COLUMN trigger_price REAL;
ALTER TABLE posts ADD COLUMN resolved_at INTEGER;
ALTER TABLE posts ADD COLUMN exit_price REAL;
ALTER TABLE posts ADD COLUMN result_r REAL;
ALTER TABLE posts ADD COLUMN last_price REAL;
-- The last session (YYYY-MM-DD) whose bar was read.
ALTER TABLE posts ADD COLUMN checked_day TEXT;
-- The last split (execution date) the levels were adjusted for.
ALTER TABLE posts ADD COLUMN split_day TEXT;
-- A post-mortem's idea; a question's accepted answer (a reply).
ALTER TABLE posts ADD COLUMN linked_id TEXT;
ALTER TABLE posts ADD COLUMN answer_id TEXT;
-- Readers who found it useful (any reason) and who found it vague.
ALTER TABLE posts ADD COLUMN useful_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE posts ADD COLUMN flag_count INTEGER NOT NULL DEFAULT 0;
CREATE INDEX posts_type ON posts(type, created_at DESC);
CREATE INDEX posts_ideas ON posts(type, status);
CREATE INDEX posts_useful ON posts(community_id, useful_count DESC);

-- Replies: 'data' | 'counterpoint' | 'question' | 'update' (or none), a useful
-- count, and an attached snapshot (picture at comments/<id> in IMAGES).
ALTER TABLE comments ADD COLUMN kind TEXT;
ALTER TABLE comments ADD COLUMN useful_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE comments ADD COLUMN chart TEXT;
ALTER TABLE comments ADD COLUMN has_image INTEGER NOT NULL DEFAULT 0;

-- Why a reader found a post useful ('thesis' | 'data' | 'view' | 'risk', or
-- 'vague': not useful), one row per reason; a reply has just 'useful'.
CREATE TABLE ratings (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL, -- 'post' | 'comment'
  target_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, target_type, target_id, reason)
);
CREATE INDEX ratings_target ON ratings(target_type, target_id);

-- Chart snapshots sent from the app to the member's account, to attach to a
-- post or a reply on the website (picture at snapshots/<id> in IMAGES).
CREATE TABLE snapshots (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chart TEXT NOT NULL,
  image_type TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX snapshots_user ON snapshots(user_id, created_at DESC);

-- "Notify me of new ideas": no follower counts, only the notice.
CREATE TABLE watches (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, author_id)
);
CREATE INDEX watches_author ON watches(author_id);

-- The profile line, and the visits: the home feed starts at the previous one.
ALTER TABLE users ADD COLUMN bio TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN seen_at INTEGER;
ALTER TABLE users ADD COLUMN prev_seen_at INTEGER;

-- Past posts asking something are questions.
UPDATE posts SET type = 'question' WHERE TRIM(title) LIKE '%?';

-- Themes fold into General: the bot's empty weekly threads go, the rest moves.
DELETE FROM bot_threads WHERE kind = 'weekly' AND community_id IN (SELECT id FROM communities WHERE kind = 'theme' AND id <> 'c:general')
  AND post_id IN (SELECT id FROM posts WHERE comment_count = 0);
DELETE FROM posts WHERE author_id = 'bot' AND comment_count = 0
  AND community_id IN (SELECT id FROM communities WHERE kind = 'theme' AND id <> 'c:general')
  AND id NOT IN (SELECT post_id FROM bot_threads);
UPDATE bot_threads SET community_id = 'c:general' WHERE community_id IN (SELECT id FROM communities WHERE kind = 'theme' AND id <> 'c:general');
UPDATE posts SET community_id = 'c:general' WHERE community_id IN (SELECT id FROM communities WHERE kind = 'theme' AND id <> 'c:general');
UPDATE reports SET community_id = 'c:general' WHERE community_id IN (SELECT id FROM communities WHERE kind = 'theme' AND id <> 'c:general');
UPDATE mod_actions SET community_id = 'c:general' WHERE community_id IN (SELECT id FROM communities WHERE kind = 'theme' AND id <> 'c:general');
DELETE FROM communities WHERE kind = 'theme' AND id <> 'c:general';
UPDATE communities SET title = 'General', description = 'Markets, process and questions that are not about one ticker.',
  post_count = (SELECT COUNT(*) FROM posts WHERE community_id = 'c:general' AND removed = 0 AND deleted = 0)
  WHERE id = 'c:general';

-- Past checks let crypto, forex and indexes through: checked again, US stocks and ETFs only.
DELETE FROM ticker_checks;
