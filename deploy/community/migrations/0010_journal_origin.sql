-- Trades shared from the app's trade journal (#248): 'journal', or NULL. Such
-- a post is labelled "From journal, self-reported": imported trades can be
-- edited before import, so it is never an idea and never in a track record.
ALTER TABLE posts ADD COLUMN origin TEXT;
