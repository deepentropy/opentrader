-- Abuse protection (#210).
-- A sign-in passes the bot check (Turnstile) before going to the provider.
ALTER TABLE logins ADD COLUMN verified INTEGER NOT NULL DEFAULT 0;
-- SHA-256 of the sender's IP address and the day: daily limits per connection
-- (new accounts, posts, comments); the address itself is never stored.
ALTER TABLE users ADD COLUMN signup_hash TEXT;
CREATE INDEX users_signup ON users(signup_hash, created_at);
ALTER TABLE posts ADD COLUMN sender_hash TEXT;
CREATE INDEX posts_sender ON posts(sender_hash, created_at);
ALTER TABLE comments ADD COLUMN sender_hash TEXT;
CREATE INDEX comments_sender ON comments(sender_hash, created_at);
-- SHA-256 of the post's normalized title and text: the same text posted again.
ALTER TABLE posts ADD COLUMN content_hash TEXT;
CREATE INDEX posts_content ON posts(content_hash, created_at);
-- Ticker communities only for known symbols: the market data's answer, kept a while.
CREATE TABLE ticker_checks (
  ticker TEXT PRIMARY KEY,
  known INTEGER NOT NULL,
  checked_at INTEGER NOT NULL
);
