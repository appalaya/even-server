-- Even sync server storage. Same tables and triggers as design.md ("Storage
-- model"), made idempotent so it can run on every start.

CREATE TABLE IF NOT EXISTS limits (     -- seeded from EVEN_* at start; /v1/info is built FROM this table
  key   TEXT PRIMARY KEY,               -- every published limit, e.g. 'max_group_bytes'
  value INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS blocked (    -- operator takedowns -> 410 group_blocked
  group_id   TEXT PRIMARY KEY,
  blocked_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS counters (   -- global daily write budget
  day    TEXT PRIMARY KEY,              -- 'YYYY-MM-DD' UTC
  writes INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS groups (
  id            TEXT PRIMARY KEY,       -- 43-char base64url
  epoch         TEXT NOT NULL,          -- 22-char base64url, random per (re)creation
  created_at    INTEGER NOT NULL,       -- unix ms
  last_write_at INTEGER NOT NULL,       -- unix ms; drives expiry
  bytes         INTEGER NOT NULL DEFAULT 0,   -- sum of events.size; maintained by trigger
  events        INTEGER NOT NULL DEFAULT 0    -- COUNT(events); maintained by trigger
);

CREATE TABLE IF NOT EXISTS events (
  group_id   TEXT    NOT NULL,
  seq        INTEGER NOT NULL,
  id         TEXT    NOT NULL,          -- 22-char base64url, client random
  v          INTEGER NOT NULL,
  n          TEXT    NOT NULL,          -- nonce
  c          TEXT    NOT NULL,          -- ciphertext, base64url as received
  size       INTEGER NOT NULL,          -- decoded length of c + 64 (protocol section 4)
  created_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, seq),
  UNIQUE     (group_id, id)
);

-- Caps and counters live in SQL so that a batch of statements is atomic.
-- BEFORE INSERT triggers fire before the uniqueness check, so a duplicate
-- must be excluded here explicitly or a full group would reject duplicates.
-- Missing limit rows fail CLOSED (COALESCE to 0), never open.
CREATE TRIGGER IF NOT EXISTS events_cap BEFORE INSERT ON events
WHEN NOT EXISTS (SELECT 1 FROM events WHERE group_id = NEW.group_id AND id = NEW.id)
 AND (
      (SELECT bytes + NEW.size FROM groups WHERE id = NEW.group_id)
        > COALESCE((SELECT value FROM limits WHERE key = 'max_group_bytes'), 0)
   OR (SELECT events + 1 FROM groups WHERE id = NEW.group_id)
        > COALESCE((SELECT value FROM limits WHERE key = 'max_group_events'), 0)
 )
BEGIN
  SELECT RAISE(ABORT, 'group_full');
END;

CREATE TRIGGER IF NOT EXISTS events_count AFTER INSERT ON events
BEGIN
  UPDATE groups SET bytes = bytes + NEW.size, events = events + 1,
                    last_write_at = NEW.created_at
   WHERE id = NEW.group_id;
END;
