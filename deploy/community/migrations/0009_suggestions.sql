-- Suggestions: members ask for features without a GitHub account. A suggestion
-- is a post (type 'suggestion') in the Suggestions community, so replies,
-- reports and moderation work as for any post. Supporters are ratings with
-- the reason 'support' (useful_count counts them); a supporter may say why in
-- a reply of kind 'support'.

INSERT OR IGNORE INTO communities (id, kind, title, description, min_account_days, sort_order, created_at) VALUES
  ('c:suggestions', 'theme', 'Suggestions', 'Features and improvements members would like in OpenTrader.', 0, 2, unixepoch());

-- 'review' | 'planned' | 'progress' | 'shipped' | 'declined'
ALTER TABLE posts ADD COLUMN sg_status TEXT;
-- The administrators' word on it (shown under the status), and when the status last changed.
ALTER TABLE posts ADD COLUMN sg_note TEXT;
ALTER TABLE posts ADD COLUMN sg_updated_at INTEGER;
-- The project's GitHub issue that tracks it.
ALTER TABLE posts ADD COLUMN issue_number INTEGER;
-- Brought in from a GitHub issue: its author's GitHub login (no account here).
ALTER TABLE posts ADD COLUMN external_author TEXT;
CREATE INDEX posts_suggestions ON posts(sg_status, useful_count DESC) WHERE sg_status IS NOT NULL;
CREATE UNIQUE INDEX posts_issue ON posts(issue_number) WHERE issue_number IS NOT NULL;
