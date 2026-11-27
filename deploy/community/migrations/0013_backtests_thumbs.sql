-- Backtests: a public strategy script run on many stocks, posted by the project through the posting API in the
-- Backtests community. The summary is in posts.backtest (JSON); the per-stock table, bars and trades, and the script
-- are files in the IMAGES bucket under backtests/<post id>/.
INSERT OR IGNORE INTO communities (id, kind, title, description, min_account_days, sort_order, created_at) VALUES
  ('c:backtests', 'theme', 'Backtests', 'Public strategy scripts backtested on US stocks: their rules, trades and results.', 0, 3, unixepoch());
ALTER TABLE posts ADD COLUMN backtest TEXT;

-- Thumbs up or down replace the useful reasons on posts: a reader's useful reasons become one thumb up, "vague" a
-- thumb down (the two already excluded each other). Replies keep their "useful" mark; suggestions their supporters.
INSERT OR IGNORE INTO ratings (user_id, target_type, target_id, reason, created_at)
  SELECT user_id, 'post', target_id, 'up', MIN(created_at) FROM ratings
   WHERE target_type = 'post' AND reason IN ('thesis', 'data', 'view', 'risk') GROUP BY user_id, target_id;
DELETE FROM ratings WHERE target_type = 'post' AND reason IN ('thesis', 'data', 'view', 'risk');
UPDATE ratings SET reason = 'down' WHERE target_type = 'post' AND reason = 'vague';
UPDATE posts SET
  useful_count = (SELECT COUNT(*) FROM ratings r WHERE r.target_type = 'post' AND r.target_id = posts.id AND r.reason = 'up'),
  flag_count = (SELECT COUNT(*) FROM ratings r WHERE r.target_type = 'post' AND r.target_id = posts.id AND r.reason = 'down')
  WHERE sg_status IS NULL;
