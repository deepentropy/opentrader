-- Bullish / bearish votes on ticker communities: one per member, ticker and
-- day (UTC days since 1970), changeable during the day.
CREATE TABLE sentiment (
  community_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day INTEGER NOT NULL,
  value INTEGER NOT NULL, -- 1 bullish, -1 bearish
  PRIMARY KEY (community_id, user_id, day)
);
CREATE INDEX sentiment_day ON sentiment(community_id, day);

-- The account of the automatic threads (no sign-in: provider 'system').
INSERT OR IGNORE INTO users (id, name, name_key, provider, provider_id, role, created_at, post_checked)
VALUES ('bot', 'OpenTrader-bot', 'opentrader-bot', 'system', 'bot', 'bot', unixepoch(), 1);

-- The threads the bot made, one per kind and key (a day, a week).
CREATE TABLE bot_threads (
  kind TEXT NOT NULL, -- 'daily' | 'weekly' | 'mover'
  key TEXT NOT NULL,  -- community id + period
  community_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (kind, key)
);
CREATE INDEX bot_threads_community ON bot_threads(kind, community_id, created_at);
