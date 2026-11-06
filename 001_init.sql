CREATE TABLE users(id INTEGER PRIMARY KEY, phone TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE otps(phone TEXT PRIMARY KEY, code_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, sent_at INTEGER NOT NULL);
CREATE TABLE sessions(token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL);
CREATE TABLE conversations(
  id INTEGER PRIMARY KEY, type TEXT NOT NULL CHECK(type IN('direct','group')), name TEXT,
  direct_key TEXT UNIQUE,                       -- "minId:maxId", makes 1:1 creation race-free
  last_seq INTEGER NOT NULL DEFAULT 0,          -- ordering counter (messages only)
  last_rev INTEGER NOT NULL DEFAULT 0,          -- change counter (new/edit/delete/membership) = sync cursor
  created_by INTEGER REFERENCES users(id), created_at INTEGER NOT NULL);
CREATE TABLE members(
  conv_id INTEGER NOT NULL REFERENCES conversations(id), user_id INTEGER NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK(role IN('admin','member')),
  joined_seq INTEGER NOT NULL DEFAULT 0,        -- member sees only messages with seq > joined_seq
  joined_at INTEGER NOT NULL, left_at INTEGER,
  delivered_seq INTEGER NOT NULL DEFAULT 0, read_seq INTEGER NOT NULL DEFAULT 0,  -- monotonic receipt cursors
  PRIMARY KEY(conv_id, user_id));
CREATE INDEX members_by_user ON members(user_id) WHERE left_at IS NULL;
CREATE TABLE messages(
  id INTEGER PRIMARY KEY, conv_id INTEGER NOT NULL REFERENCES conversations(id),
  seq INTEGER NOT NULL, rev INTEGER NOT NULL, sender_id INTEGER NOT NULL REFERENCES users(id),
  client_id TEXT NOT NULL,                      -- idempotency key chosen by the client
  text TEXT, reply_to INTEGER, created_at INTEGER NOT NULL, edited_at INTEGER, deleted_at INTEGER,
  UNIQUE(conv_id, seq), UNIQUE(conv_id, sender_id, client_id));
CREATE INDEX messages_by_rev ON messages(conv_id, rev);
