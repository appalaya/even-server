-- Even sync server storage (design.md, "Storage model"): the same tables, index and triggers as the Python reference,
-- written idempotently so that `npm run db:schema` can be re-run safely: everything is CREATE … IF NOT EXISTS except
-- events_count, which is dropped and created again so that its current definition always wins.
--
-- Apply with:  npx wrangler d1 execute even --local  --file schema.sql     (npm run db:schema)
-- Production:  the deploy workflow runs the same with --remote on every deploy (README.md, "Deploying").

CREATE TABLE IF NOT EXISTS limits (     -- seeded from EVEN_* vars (seed-limits.sql); /v1/info is built FROM this table
  key   TEXT PRIMARY KEY,               -- every published limit, e.g. 'max_group_bytes'
  value INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS blocked (    -- operator takedowns -> 410 group_blocked
  group_id   TEXT PRIMARY KEY,
  blocked_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS counters (   -- global daily write budget
  day    TEXT PRIMARY KEY,              -- 'YYYY-MM-DD' UTC
  writes INTEGER NOT NULL               -- events stored that day, duplicates not counted
);

CREATE TABLE IF NOT EXISTS groups (
  id            TEXT PRIMARY KEY,       -- 43-char base64url
  epoch         TEXT NOT NULL,          -- 22-char base64url, random per (re)creation
  created_at    INTEGER NOT NULL,       -- unix ms
  last_write_at INTEGER NOT NULL,       -- unix ms: the latest append's arrival time (received_at); drives expiry
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
  created_at INTEGER NOT NULL,          -- unix ms: received_at, the arrival time of the append that stored it
  PRIMARY KEY (group_id, seq),
  UNIQUE     (group_id, id)
);

-- Expiry takes idle groups oldest first, a bounded batch at a time (design.md, "Expiry").
CREATE INDEX IF NOT EXISTS groups_last_write_at ON groups (last_write_at);

-- Caps and counters live in SQL so that a batch of statements is atomic
-- without an interactive transaction (D1 has none).
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

-- last_write_at is indexed (groups_last_write_at, below), and an UPDATE that assigns an indexed column rewrites its
-- index entry even when the value does not change, which on D1 is a row written. So the counts are updated per event
-- and last_write_at only when it moves, and never backwards. An append sets last_write_at to its arrival time before
-- its inserts (design.md, "Append"), so for an append this finds nothing to move; it keeps last_write_at at or above
-- every created_at in the group, which the next arrival time relies on, whatever inserted the row. Replaced on every
-- run (DROP, then CREATE) so that a database created with an earlier definition gets this one; that leaves data alone.
DROP TRIGGER IF EXISTS events_count;
CREATE TRIGGER events_count AFTER INSERT ON events
BEGIN
  UPDATE groups SET bytes = bytes + NEW.size, events = events + 1 WHERE id = NEW.group_id;
  UPDATE groups SET last_write_at = NEW.created_at
   WHERE id = NEW.group_id AND last_write_at < NEW.created_at;
END;

-- The daily write budget counts events stored, duplicates not counted. The append batch adds the number of its
-- envelopes not yet in the group to the day's counter (nothing at all when every one is a duplicate), and these
-- triggers refuse a count past the budget, so appends in flight at the boundary cannot overshoot it. 0 means no
-- budget; a missing row fails CLOSED. The first counted append of a day inserts its count, which can already pass a
-- small budget, so the insert is checked as well as the update. (An upsert fires the BEFORE INSERT trigger even
-- when it goes on to update, with NEW.writes = that append's count; refusing it then is right too.)
CREATE TRIGGER IF NOT EXISTS counters_budget BEFORE UPDATE OF writes ON counters
WHEN NEW.writes > COALESCE((SELECT value FROM limits WHERE key = 'daily_write_budget'), 0)
 AND (SELECT value FROM limits WHERE key = 'daily_write_budget') IS NOT 0
BEGIN
  SELECT RAISE(ABORT, 'over_budget');
END;

CREATE TRIGGER IF NOT EXISTS counters_budget_insert BEFORE INSERT ON counters
WHEN NEW.writes > COALESCE((SELECT value FROM limits WHERE key = 'daily_write_budget'), 0)
 AND (SELECT value FROM limits WHERE key = 'daily_write_budget') IS NOT 0
BEGIN
  SELECT RAISE(ABORT, 'over_budget');
END;
