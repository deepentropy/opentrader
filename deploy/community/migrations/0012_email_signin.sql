-- Sign-in with an e-mail address (provider 'email', provider_id: the address
-- in lower case): a 6-digit code sent to it, good for the sign-in that asked.
ALTER TABLE logins ADD COLUMN mail TEXT;
-- SHA-256 of the state and the code; NULL once used or after too many tries.
ALTER TABLE logins ADD COLUMN mail_code_hash TEXT;
ALTER TABLE logins ADD COLUMN mail_code_at INTEGER;
ALTER TABLE logins ADD COLUMN mail_tries INTEGER NOT NULL DEFAULT 0;
ALTER TABLE logins ADD COLUMN mail_sent INTEGER NOT NULL DEFAULT 0;
-- The code was right: a new account still picks its user name.
ALTER TABLE logins ADD COLUMN mail_ok INTEGER NOT NULL DEFAULT 0;

-- Codes sent over the last day: limits per address and per connection.
CREATE TABLE mail_sends (
  address_hash TEXT NOT NULL,
  sender_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX mail_sends_address ON mail_sends(address_hash, created_at);
CREATE INDEX mail_sends_sender ON mail_sends(sender_hash, created_at);
