-- Contact point (EU Digital Services Act): messages from anyone, signed in or
-- not, read by the administrators. The e-mail address goes once handled.
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL, -- 'illegal' | 'appeal' | 'authority' | 'other'
  email TEXT,
  url TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  -- SHA-256 of the sender's address and the day: only to limit messages per day.
  sender_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', -- 'open' | 'done'
  created_at INTEGER NOT NULL,
  handled_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  handled_at INTEGER
);
CREATE INDEX messages_open ON messages(status, created_at);
CREATE INDEX messages_sender ON messages(sender_hash, created_at);
