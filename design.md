# Design — Even Sync Server

Architecture of the two reference servers and the conformance suite. The
protocol itself is in `PROTOCOL.md`; this document is about implementing it.

## Shape

```
  Even app ──HTTPS──▶  /v1/info
                       /v1/groups/{id}/events   (POST append, GET read)
                       /v1/groups/{id}          (DELETE)
                       /v1/groups/{id}/subscriptions   (501, reserved)
                             │
                       ┌─────┴─────┐
                       │  storage  │   groups, events, limits
                       └───────────┘
```

Both references are a few hundred lines in different clothes. Neither has
business logic beyond: check token, validate envelope, assign sequence, enforce
caps, page results.

## Storage model (both references)

```sql
CREATE TABLE limits (                   -- seeded from EVEN_* at deploy/start; /v1/info is built FROM this table
  key   TEXT PRIMARY KEY,               -- every published limit, e.g. 'max_group_bytes'
  value INTEGER NOT NULL
);

CREATE TABLE blocked (                  -- operator takedowns → 410 group_blocked
  group_id   TEXT PRIMARY KEY,
  blocked_at INTEGER NOT NULL
);

CREATE TABLE counters (                 -- global daily write budget
  day    TEXT PRIMARY KEY,              -- 'YYYY-MM-DD' UTC
  writes INTEGER NOT NULL               -- events stored that day, duplicates not counted
);

CREATE TABLE groups (
  id            TEXT PRIMARY KEY,       -- 43-char base64url
  epoch         TEXT NOT NULL,          -- 22-char base64url, random per (re)creation
  created_at    INTEGER NOT NULL,       -- unix ms
  last_write_at INTEGER NOT NULL,       -- unix ms: the latest append's arrival time (received_at); drives expiry
  bytes         INTEGER NOT NULL DEFAULT 0,   -- Σ events.size; maintained by trigger
  events        INTEGER NOT NULL DEFAULT 0    -- COUNT(events); maintained by trigger
);

CREATE TABLE events (
  group_id   TEXT    NOT NULL,
  seq        INTEGER NOT NULL,
  id         TEXT    NOT NULL,          -- 22-char base64url, client random
  v          INTEGER NOT NULL,
  n          TEXT    NOT NULL,          -- nonce
  c          TEXT    NOT NULL,          -- ciphertext, base64url as received
  size       INTEGER NOT NULL,          -- decoded length of c + 64 (protocol §4)
  created_at INTEGER NOT NULL,          -- unix ms: received_at, the arrival time of the append that stored it
  PRIMARY KEY (group_id, seq),
  UNIQUE     (group_id, id)
);

-- Caps and counters live in SQL so that a batch of statements is atomic
-- without an interactive transaction (D1 has none).
-- BEFORE INSERT triggers fire before the uniqueness check, so a duplicate
-- must be excluded here explicitly or a full group would reject duplicates.
-- Missing limit rows fail CLOSED (COALESCE to 0), never open.
CREATE TRIGGER events_cap BEFORE INSERT ON events
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

-- Two updates, not one: last_write_at is indexed (below), and assigning an
-- indexed column rewrites its index entry, a D1 row written, even when the
-- value does not change. An append sets last_write_at to its arrival time
-- before its inserts (Append, below), so for an append the second update
-- finds nothing to move; it keeps last_write_at at or above every created_at
-- in the group, whatever inserted the row, and never moves it backwards.
CREATE TRIGGER events_count AFTER INSERT ON events
BEGIN
  UPDATE groups SET bytes = bytes + NEW.size, events = events + 1 WHERE id = NEW.group_id;
  UPDATE groups SET last_write_at = NEW.created_at
   WHERE id = NEW.group_id AND last_write_at < NEW.created_at;
END;

CREATE INDEX groups_last_write_at ON groups (last_write_at);   -- expiry, oldest first

-- The daily write budget, in events stored, checked as the append batch adds
-- its new events to the day's counter, so appends in flight at the boundary
-- cannot overshoot it. 0 means no budget; a missing row fails CLOSED. The
-- first counted append of a day inserts its count, which can already pass a
-- small budget, so the insert is checked as well as the update.
CREATE TRIGGER counters_budget BEFORE UPDATE OF writes ON counters
WHEN NEW.writes > COALESCE((SELECT value FROM limits WHERE key = 'daily_write_budget'), 0)
 AND (SELECT value FROM limits WHERE key = 'daily_write_budget') IS NOT 0
BEGIN
  SELECT RAISE(ABORT, 'over_budget');
END;

CREATE TRIGGER counters_budget_insert BEFORE INSERT ON counters
WHEN NEW.writes > COALESCE((SELECT value FROM limits WHERE key = 'daily_write_budget'), 0)
 AND (SELECT value FROM limits WHERE key = 'daily_write_budget') IS NOT 0
BEGIN
  SELECT RAISE(ABORT, 'over_budget');
END;
```

`bytes` counts stored size as the protocol defines it (decoded ciphertext plus
64), not base64 length, so the published cap means what it says. The trigger
pair on `events` is the whole cap and accounting implementation; nothing in
application code sums bytes. The two `counters_budget` triggers do the same
for the daily write budget.

## Request handling

Every group-scoped request runs the same prelude:

1. Parse `groupId` from the path; `400 invalid_request` if not exactly 43
   base64url chars.
2. Read the bearer token; `401 unauthorized` if not exactly 43 base64url chars.
3. `expected = base64url(sha256(base64urlDecode(token)))`; compare with
   `groupId`; `401` on mismatch.
4. Rate-limit check for the client IP (below), and for an event read the
   first unit of its read allowance (see Read). Auth runs first so that an
   unauthenticated flood cannot consume the creation limiter for a real group.
   In the Worker this comes before any D1 read: the thresholds are binding
   configuration, so a refused request costs no database rows. The Python
   reference keeps its thresholds in the `limits` table and reads them (with
   the blocklist and the group row, in one snapshot of the local file) first;
   the order a client sees is the same.
5. `410 group_blocked` if `groupId` is in `blocked`. This applies to every
   group-scoped route, including the reserved subscriptions route. A blocked
   group's requests count against the limiter like any other.

No lookup is needed to authenticate. A group that does not exist is simply one
with no rows.

### Append (`POST …/events`)

1. Parse body; `400 invalid_request` unless `events` is an array of 1..`max_batch`.
2. Validate every envelope structurally (protocol §4), in order. First
   structural failure → `400 invalid_envelope { index }`. Then, if any envelope
   has an unknown `v` → `415 unsupported_version { index }`. Compute `size` for
   each. Collapse ids repeated within the request to their first occurrence.
3. Check the per-IP write limiter and, if the group has no row yet, the
   creation limiter.
4. Run one atomic batch:
   ```sql
   -- today (UTC) += the request's ids the group does not hold yet; no row at all when that is 0
   INSERT INTO counters (day, writes)
     SELECT ?, n FROM (SELECT COUNT(*) AS n FROM json_each(?) AS j    -- the ids, as a JSON array
                        WHERE NOT EXISTS (SELECT 1 FROM events WHERE group_id = ? AND id = j.value))
      WHERE n > 0
     ON CONFLICT (day) DO UPDATE SET writes = writes + excluded.writes;
   -- the request's arrival time, for a group that exists and only if the request holds a new id
   UPDATE groups SET last_write_at = MAX(:now, last_write_at + 1)
    WHERE id = ? AND EXISTS (SELECT 1 FROM json_each(?) AS j
                              WHERE NOT EXISTS (SELECT 1 FROM events WHERE group_id = ? AND id = j.value));
   INSERT OR IGNORE INTO groups (id, epoch, created_at, last_write_at) VALUES (?, ?, :now, :now);
   -- one per envelope, in request order:
   INSERT OR IGNORE INTO events (group_id, seq, id, v, n, c, size, created_at)
     SELECT ?, COALESCE(MAX(seq), 0) + 1, ?, ?, ?, ?, ?, (SELECT last_write_at FROM groups WHERE id = ?)
       FROM events WHERE group_id = ?;
   SELECT epoch, (SELECT MAX(seq) FROM events WHERE group_id = ?) FROM groups WHERE id = ?;
   SELECT id, created_at FROM events WHERE group_id = ? AND id IN (SELECT value FROM json_each(?));
   ```
   Each insert computes its own `seq` from `MAX(seq)` inside the statement, so
   consecutive inserts in the batch get consecutive values. `INSERT OR IGNORE`
   skips duplicates by the `(group_id, id)` unique constraint without touching
   `seq` or the stored row. The counter statement runs first and counts exactly
   the inserts that will change a row, since nothing else can write in between.
   A budget trigger aborts the whole batch if the count would pass the daily
   budget, and the cap trigger if any insert would exceed a cap; the batch rolls
   back, counter and arrival time included, and the handler maps `over_budget`
   to `503` and `group_full` to `413`.
5. `accepted` = number of inserts that changed a row (from the driver's
   per-statement change count); `duplicates` = envelopes − accepted;
   `received_at` = the stored `created_at` of each envelope's id, in request
   order, repeats included. Return `{ accepted, duplicates, seq, epoch,
   received_at }`, in that order in both references.

**Arrival time (`received_at`).** Each event's `created_at` is its
`received_at` (protocol §4): every envelope one request stores gets the same
value, `max(now, the group's previous value + 1)`, so it is equal within a
request and strictly increasing across requests in `seq` order, however close
together they arrive or however the clocks of the Worker's machines disagree.
The previous value is the group's `last_write_at`: the batch advances it
before its inserts and each insert copies it, so the value is decided once per
request without an interactive transaction. A new group's row is inserted with
`now`, which the inserts copy. An append whose every envelope is a duplicate
stores nothing, so it leaves `last_write_at` (and expiry) alone and assigns
nothing; it reports the values already stored, as every duplicate does. A
stored row is never updated, so a value never changes within an epoch. A
delete or expiry removes the group row with its events, so the next write
starts again from `now`: a recreated group's values are fresh and no earlier
than the recreate time. The `events_count` trigger keeps `last_write_at` at or
above every `created_at`, so the rule holds for rows stored before it existed.
This needs no schema change, and adds rows read but no rows written:
`last_write_at` already moved once per append that stored anything.

**Atomicity.** In D1, `batch()` runs its statements in one implicit
transaction, and D1 serialises writes per database, so two concurrent appends
never interleave. In the Python reference the batch runs under
`BEGIN IMMEDIATE`, which takes the write lock before the first `MAX(seq)` read.
The conformance suite fires concurrent appends and checks the result.

### Read (`GET …/events`)

```sql
SELECT seq, id, v, n, c, created_at AS received_at FROM events
 WHERE group_id = ? AND seq > ?
 ORDER BY seq LIMIT ?;          -- limit = clamp(requested, 1, max_page) + 1
```

Each event is returned as `{ seq, id, v, n, c, received_at }`, in that order
in both references.

Fetch one row more than the limit; if it arrives, `more = true` and it is
dropped from the response. `next` = last returned `seq`, else the request's
`since`. `epoch` from the groups row, or `null` if none. Reads do not touch
`last_write_at`; a group that is only ever read still expires. This is
deliberate: a group nobody writes to has been settled and exported, or is
abandoned, and every member still has it locally.

**The read allowance.** Event reads are limited per IP in units of 100
database rows read, counted as D1 counts them (`meta.rows_read`): a read costs
`ceil(rows / 100)` units, at least 1. A read's rows are the prelude's (the 11
`limits` rows and the group row), the group row again for the epoch, and the
events after `since` up to the limit, plus one (the look-ahead row, or the
index entry where the scan stops): 14 for a poll with nothing new (1 unit),
514 for a full page of 500 with more to come (6 units). The cost is known
before the page is read: the prelude reads the group's `events` count, and
`seq` runs 1..`events` within an epoch with no gaps (events are deleted only
with their group), so `events − since` events follow the cursor. The first
unit is taken in the prelude; the rest after the `since`/`limit` checks and
before the page is read, and if they do not fit the read is refused with
`429` and reads nothing more. A read is never charged more than the whole
allowance, so a full page always fits in a fresh minute. The Workers binding
has no weight, so a unit is one `limit()` call and units taken before a
refusal stay spent; the Python reference counts the rest all or nothing. Both
compute the same rows, so they charge the same units.

### Delete (`DELETE …`)

Delete events then the group row, in one batch. `204` regardless. The next
write creates a fresh row with a fresh epoch.

### Info (`GET /v1/info`)

Assembled from the `limits` table (seeded from configuration at deploy or
start), so what is published is exactly what the triggers and handlers
enforce. No auth. The Worker checks the request limiter before it reads the
table. Every enforced limit appears here, including the rate
limits and the daily write budget.

### Global write budget

The budget counts **events stored** per UTC day across all groups, not append
requests, and not duplicates: what costs storage and database writes is a new
event, whether it arrives alone or in a full batch. The append batch adds its
new events to the day's counter in `counters`, where the `counters_budget`
triggers refuse a count past `EVEN_DAILY_WRITE_BUDGET`, so the budget is exact
however many appends are in flight. An append that would pass it is refused
whole with `503 over_budget` and `Retry-After` until midnight UTC, even when a
smaller one would still fit; reads continue, and so does an append of
duplicates only, which stores and counts nothing.
This bounds the free tier's row-write quota and, on a paid plan, the bill.
`0` disables it, and the value is published in `/v1/info` as
`limits.daily_write_budget` either way.

### Takedown

`blocked` is edited by the operator with one SQL statement. A blocked id
answers `410` to everything. Deleting a group instead of blocking it is
pointless: the next member who syncs sees a new epoch and re-pushes the log.

## Limits and configuration

Every number is configuration with a default. Both references read the same
`EVEN_*` names. In the Worker, values come from `wrangler.jsonc` `vars` (and
the four rate limiters are bindings whose thresholds are declared alongside);
in Python they are environment variables. The `limits` table is seeded from
them at deploy or start.

| Name | Default | Enforced where |
|---|---|---|
| `EVEN_MAX_EVENT_BYTES` | `8192` | Envelope validation |
| `EVEN_MAX_GROUP_BYTES` | `2097152` | Trigger |
| `EVEN_MAX_GROUP_EVENTS` | `10000` | Trigger; bounds non-conforming tiny events, since padding already caps conforming ones at ~6,500 per 2 MiB |
| `EVEN_MAX_BATCH` | `25` | Append body |
| `EVEN_MAX_PAGE` | `500` | Read query |
| `EVEN_RETENTION_DAYS` | `365` | Expiry job |
| `EVEN_RATE_REQUESTS_PER_MINUTE` | `120` | Per IP, all endpoints |
| `EVEN_RATE_WRITES_PER_MINUTE` | `60` | Per IP, append. A whole group behind one NAT shares this, and everyone re-pushes at once after an epoch change, hence not lower |
| `EVEN_RATE_GROUP_CREATES_PER_MINUTE` | `3` | Per IP, first write to a new group |
| `EVEN_RATE_READS_PER_MINUTE` | `720` (public server: `120`) | Per IP, event reads (`GET …/events`) in units of 100 rows read: a poll with nothing new costs 1, a full page of 500 costs 6 (Read, above). The default, 120 full pages, changes nothing beyond the request limit; the public server sets it for D1's rows-read allowance: 120 units is at most 17.3 million rows a day per address |
| `EVEN_DAILY_WRITE_BUDGET` | `6500` (public server: `50000`) | Append, global: events stored per UTC day, duplicates not counted |
| `EVEN_TRUST_PROXY_HEADER` | unset | Python: `CF-Connecting-IP` or `X-Forwarded-For` |
| `EVEN_OPERATOR` | unset | `/v1/info` |
| `EVEN_TERMS_URL` | unset | `/v1/info` |

`max_batch` defaults to 25 everywhere because a 100 × 8 KB batch can exceed
the Workers free-plan CPU budget per request, and a self-hoster gains nothing
from a bigger default.

## Expiry

A scheduled job, daily, deletes groups where `last_write_at < now − retention`
and their events. In the Worker this is a Cron Trigger. In the Python reference
it is a background thread with a 24-hour sleep, plus a `--expire-now` flag for
cron users.

Every group goes whole, its events and its row in one transaction: a group
left alive with part of its log would keep its epoch, and a client syncing from
0 would get a hole it cannot detect. Within that, the Worker's run is bounded,
because one D1 transaction cannot delete millions of rows, and a batch that
fails every day would never expire anything:

```sql
-- One batch's groups (?1 cutoff, ?2 = 100 groups, ?3 = 1,000 events): through
-- the last_write_at index, oldest first, keeping a group while the events of
-- the groups before it are fewer than ?3. The first group always goes, so a
-- batch is at most 1,000 events plus one group (at most max_group_events).
SELECT id FROM (
  SELECT id, SUM(events) OVER (ORDER BY last_write_at, r
                               ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS before
    FROM (SELECT rowid AS r, id, events, last_write_at FROM groups
           WHERE last_write_at < ?1 ORDER BY last_write_at, rowid LIMIT ?2)
) WHERE COALESCE(before, 0) < ?3;
-- batch: DELETE FROM events WHERE group_id IN (…); DELETE FROM groups WHERE id IN (…)
```

A run repeats batches until none is left, or it has written 10,000 D1 rows
(`meta.rows_written`), or 20 batches; the next day's run carries on. The log
line says whether the run was `complete`. The Python reference uses the same
batches, each its own transaction so requests interleave, and runs until none
is left (it has no daily row quota).

## Rate limiting

- **Worker:** the Workers Rate Limiting binding supports 10- and 60-second
  periods only, which is why every rate is expressed per minute. Four
  limiters, keyed by client IP (`CF-Connecting-IP`, IPv6 truncated to /64):
  requests, writes, creations, and event reads (one call per unit of 100
  rows a read costs, since the binding has no weight). Falls back to allow if a
  binding is missing so a self-deployed Worker without them still works. The
  limits are approximate and per-location; that is fine for abuse control.
- **Python:** an in-memory sliding window per key, same four limits, a read
  counting its units at once. Behind
  Caddy, nginx, or a Cloudflare Tunnel every client shares one IP unless
  `EVEN_TRUST_PROXY_HEADER` names the header to read; the README says so
  loudly. Every line of that header is read and the right-most address wins,
  the one the single trusted proxy added.

Rate-limit state is the only per-IP data either server keeps, and it lives in
memory or in the platform's limiter, never in the database.

## Logging

Structured one-line-per-request logs with: method, route *pattern*, status,
duration, and whether it was rate-limited. No bodies, no tokens, no URLs, no
group ids, no IPs.

- **Worker:** `console.log` JSON lines. `observability.logs.invocation_logs`
  is **off** in `wrangler.jsonc`, because invocation logs record the request
  URL, which contains the group id.
- **Python:** the standard `logging` module; uvicorn started with its access
  log off and WebSockets off (uvicorn logs every WebSocket handshake with the
  client address and URL, through its error logger). One JSON formatter is the
  boundary for every line: the server's own lines are structured fields;
  anything from uvicorn or another library is written as its format string,
  never with its arguments, and scrubbed of paths, ids and addresses.
  Tracebacks are never written. The README states that Caddy's `log`
  directive records full URIs and shows how to disable or redact it, and its
  `Caddyfile.example` handles errors itself (`handle_errors`), so that Caddy's
  own error lines, which carry the URI and client address, stay at DEBUG.

## The Worker (`worker/`)

- Plain `fetch` handler, no framework. Routing is a handful of `if` statements
  against `URL.pathname`; a router would be the largest dependency in the
  project. Unknown route → `404 not_found`; known route, wrong method →
  `405 method_not_allowed`.
- `wrangler.jsonc` declares: the D1 binding, four rate limiters, the cron
  trigger, `vars` for every `EVEN_*` value, `compatibility_date`, and
  observability with invocation logs disabled.
- `schema.sql` (tables and triggers) is applied with `wrangler d1 execute`, and
  a `seed-limits.sql` generated from `vars` at deploy. `/v1/info` reads the
  `limits` table, not `vars`, so what is published is what is enforced. No
  migration framework; there are five small tables and the protocol is
  versioned by path.
- Deployed only by GitHub Actions (`.github/workflows/deploy.yml`), which finds
  or creates the D1 database, applies `schema.sql` and the seed, and runs
  `wrangler deploy`. The free server is this, at the Workers custom domain
  `sync.even.appalaya.com`; `workers.dev` and preview URLs are off.

## The Python reference (`python/`)

- FastAPI + `sqlite3` from the standard library, a small package. One SQLite
  connection per process, shared under a lock.
- **Python 3.14 or newer is required** (`requires-python = ">=3.14"` in
  `pyproject.toml`); developed in a venv with pinned `requirements.txt`.
- `Dockerfile` and a `docker-compose.yml` that mounts a volume for the database.
- `README.md` walks through Caddy for HTTPS, because that is the step that
  costs self-hosters the most time, and through the proxy-header and
  access-log settings above.

## Conformance suite (`conformance/`)

- TypeScript with Vitest, using global `fetch`. Run with
  `EVEN_SERVER_URL=https://… npx vitest run`.
- Generates its own secrets, derives tokens and ids exactly as the client
  does, so it doubles as the reference implementation of protocol §2.
- Reads `/v1/info` first and **refuses to report success** unless
  `max_group_bytes ≤ 65536` and `max_group_events ≤ 200`, printing the reason.
  Public servers are tested through a staging deployment with test limits.
- Tests, one per MUST:
  - info shape, every limit present including `rate`
  - append then read round-trip; `next`, `more`, and `epoch` semantics; `limit`
    clamping at `max_page`; `limit=0` → 400
  - duplicate ids ignored and counted, within one request and across requests;
    stored content never replaced; a 200 acknowledges duplicates
  - whole-batch rejection on one bad envelope, with `index`; 400 takes
    precedence over 415 when both occur
  - every malformed-envelope variant (extra field, wrong id length, bad
    charset, undersized and oversized `c`, unknown `v` → 415 with `index`)
  - malformed `groupId` path → 400; wrong token → 401; missing group → empty
    200 with `epoch: null`
  - `group_full` at both the byte and the event boundary, nothing stored,
    duplicates not counted toward caps, and a batch of only duplicates
    succeeds against a full group
  - a blocked id → 410 on every group route; subscriptions → 401 before 501
    when the token is wrong
  - **concurrent appends**: N parallel requests, then read all, assert `seq`
    is 1..total with no gaps or duplicates and each request's envelopes are
    contiguous
  - delete → 204 → read returns empty → append recreates with a **different
    epoch** and `seq` restarting at 1
  - `received_at` on every pulled envelope (a safe integer within 5 minutes of
    the runner's clock at the append) and one per envelope in the push
    response, in request order, a duplicate reporting the stored value; stable
    across re-reads and duplicate re-pushes; equal within a request and
    strictly increasing across requests in `seq` order, in the concurrency
    tests too; new and no earlier than the recreate time after a delete; the
    same in push and pull
  - `Cache-Control: no-store` on every response
  - subscriptions → 501 when `/v1/info.push` is false; unknown route → 404;
    wrong method → 405

## What is intentionally not here

No users. No sessions. No admin endpoints. No content parsing. No client
version checks. No analytics. Each absence is load-bearing: see
`THREAT-MODEL.md`.
