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
  last_write_at INTEGER NOT NULL,       -- unix ms; drives expiry
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
  created_at INTEGER NOT NULL,
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

CREATE TRIGGER events_count AFTER INSERT ON events
BEGIN
  UPDATE groups SET bytes = bytes + NEW.size, events = events + 1,
                    last_write_at = NEW.created_at
   WHERE id = NEW.group_id;
END;

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
4. Rate-limit check for the client IP (below). Auth runs first so that an
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
   INSERT OR IGNORE INTO groups (id, epoch, created_at, last_write_at) VALUES (?, ?, ?, ?);
   -- one per envelope, in request order:
   INSERT OR IGNORE INTO events (group_id, seq, id, v, n, c, size, created_at)
     SELECT ?, COALESCE(MAX(seq), 0) + 1, ?, ?, ?, ?, ?, ? FROM events WHERE group_id = ?;
   SELECT epoch, events, (SELECT MAX(seq) FROM events WHERE group_id = ?) FROM groups WHERE id = ?;
   ```
   Each insert computes its own `seq` from `MAX(seq)` inside the statement, so
   consecutive inserts in the batch get consecutive values. `INSERT OR IGNORE`
   skips duplicates by the `(group_id, id)` unique constraint without touching
   `seq`. The counter statement runs first and counts exactly the inserts that
   will change a row, since nothing else can write in between. A budget trigger
   aborts the whole batch if the count would pass the daily budget, and the cap
   trigger if any insert would exceed a cap; the batch rolls back, counter
   included, and the handler maps `over_budget` to `503` and `group_full` to
   `413`.
5. `accepted` = number of inserts that changed a row (from the driver's
   per-statement change count); `duplicates` = envelopes − accepted. Return
   `{ accepted, duplicates, seq, epoch }`.

**Atomicity.** In D1, `batch()` runs its statements in one implicit
transaction, and D1 serialises writes per database, so two concurrent appends
never interleave. In the Python reference the batch runs under
`BEGIN IMMEDIATE`, which takes the write lock before the first `MAX(seq)` read.
The conformance suite fires concurrent appends and checks the result.

### Read (`GET …/events`)

```sql
SELECT seq, id, v, n, c FROM events
 WHERE group_id = ? AND seq > ?
 ORDER BY seq LIMIT ?;          -- limit = clamp(requested, 1, max_page) + 1
```

Fetch one row more than the limit; if it arrives, `more = true` and it is
dropped from the response. `next` = last returned `seq`, else the request's
`since`. `epoch` from the groups row, or `null` if none. Reads do not touch
`last_write_at`; a group that is only ever read still expires. This is
deliberate: a group nobody writes to has been settled and exported, or is
abandoned, and every member still has it locally.

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
| `EVEN_RATE_READS_PER_MINUTE` | `120` (public server: `5`) | Per IP, event reads (`GET …/events`). The default changes nothing beyond the request limit; the public server sets it for D1's daily rows-read quota, since a full page reads about 514 rows |
| `EVEN_DAILY_WRITE_BUDGET` | `0` (public server: `7400`) | Append, global: events stored per UTC day, duplicates not counted |
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

## Rate limiting

- **Worker:** the Workers Rate Limiting binding supports 10- and 60-second
  periods only, which is why every rate is expressed per minute. Four
  limiters, keyed by client IP (`CF-Connecting-IP`, IPv6 truncated to /64):
  requests, writes, creations, and event reads. Falls back to allow if a
  binding is missing so a self-deployed Worker without them still works. The
  limits are approximate and per-location; that is fine for abuse control.
- **Python:** an in-memory sliding window per key, same four limits. Behind
  Caddy, nginx, or a Cloudflare Tunnel every client shares one IP unless
  `EVEN_TRUST_PROXY_HEADER` names the header to read; the README says so
  loudly.

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
  directive records full URIs and shows how to disable or redact it.

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

- FastAPI + `sqlite3` from the standard library, a small package.
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
  - `Cache-Control: no-store` on every response
  - subscriptions → 501 when `/v1/info.push` is false; unknown route → 404;
    wrong method → 405

## What is intentionally not here

No users. No sessions. No admin endpoints. No content parsing. No client
version checks. No analytics. Each absence is load-bearing: see
`THREAT-MODEL.md`.
