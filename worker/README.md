# Even sync server: Cloudflare Workers + D1 reference

The Worker that runs the public server at `https://sync.even.appalaya.com`. It implements
[`PROTOCOL.md`](../PROTOCOL.md) v1: it stores client-encrypted envelopes per group, hands them back in order, and
cannot read any of them. It passes the [conformance suite](../conformance/) (below).

No framework and no runtime dependencies. Dev dependencies are `wrangler`, `typescript`,
`@cloudflare/workers-types`, `vitest` and `@cloudflare/vitest-pool-workers`. Node 24 or newer.

```
wrangler.jsonc          D1 binding, three rate limiters, cron, EVEN_* vars, observability (invocation logs off)
schema.sql              tables and the two cap/accounting triggers (design.md, "Storage model")
scripts/seed-limits.mjs vars → seed-limits.sql (the `limits` table); refuses bad values and limiter mismatches
src/index.ts            fetch (route, handle, headers, one log line) and scheduled (expiry)
src/routes.ts           routing, the request prelude, and the §6 handlers
src/db.ts               every D1 statement; appends are one atomic batch()
src/envelope.ts         §4/§6.2 validation (400 before 415 across the batch)
src/auth.ts  src/b64.ts bearer token → group id; strict base64url
src/limits.ts           the limits table and the /v1/info document built from it
src/ratelimit.ts        per-IP limiters, IPv6 by /64
src/log.ts              the whole log surface
src/vars.ts             the EVEN_* → limits-table mapping, shared by the Worker and the seed script
test/                   unit and integration tests, run inside workerd against an in-memory D1
```

## Local development

Everything here runs locally with no Cloudflare account.

```sh
cd worker
npm install
npm run db:schema && npm run db:seed    # local D1: tables + triggers, then the limits table from vars
npm run dev                             # http://127.0.0.1:8787 with the production defaults
```

`npm run typecheck` checks `src/` and `test/` (TypeScript strict). `npm test` runs the Worker's own tests inside
workerd through `@cloudflare/vitest-pool-workers`, against an in-memory D1 with `schema.sql` applied: the round trip,
the triggers (including fail-closed when a cap row is missing), the daily budget, the blocklist, the rate-limit paths
(with fake bindings), the log lines, and expiry. The conformance suite remains the definition of correctness.

### Smoke test

With `npm run dev:test` (next section) running:

```sh
S=http://127.0.0.1:8787
curl -s $S/v1/info; echo

# A token and its group id, derived as a client does (PROTOCOL.md §2: groupId = base64url(SHA-256(token)))
eval "$(node -e 'const c=require("node:crypto"),t=c.randomBytes(32);console.log(`TOKEN=${t.toString("base64url")} GROUP=${c.createHash("sha256").update(t).digest("base64url")}`)')"
AUTH="Authorization: Bearer $TOKEN"
# One envelope: 16-byte id, 24-byte nonce, 256 random bytes standing in for a ciphertext
BODY=$(node -e 'const r=n=>require("node:crypto").randomBytes(n).toString("base64url");console.log(JSON.stringify({events:[{id:r(16),v:1,n:r(24),c:r(256)}]}))')

curl -s -X POST -H "$AUTH" -d "$BODY" $S/v1/groups/$GROUP/events; echo                          # append
curl -s -H "$AUTH" $S/v1/groups/$GROUP/events | node -pe \
  'const r=JSON.parse(require("fs").readFileSync(0));r.events.forEach(e=>e.c=e.c.slice(0,12)+"…");JSON.stringify(r)'  # read
curl -s -o /dev/null -w '%{http_code}\n' -X DELETE -H "$AUTH" $S/v1/groups/$GROUP                 # delete
curl -s -X POST -H "$AUTH" -d "$BODY" $S/v1/groups/$GROUP/events; echo                          # recreate
BAD=$(node -e 'const b=JSON.parse(process.argv[1]);b.events.push({id:"short",v:1,n:"x",c:"y"});console.log(JSON.stringify(b))' "$BODY")
curl -s -w ' %{http_code}\n' -X POST -H "$AUTH" -d "$BAD" $S/v1/groups/$GROUP/events           # malformed
curl -s -w ' %{http_code}\n' -H "Authorization: Bearer $(node -p 'require("node:crypto").randomBytes(32).toString("base64url")')" \
  $S/v1/groups/$GROUP/events                                                                    # wrong token
```

Output from a real run:

```
{"protocol":[1],"limits":{"max_event_bytes":8192,"max_group_bytes":65536,"max_group_events":200,"max_batch":25,"max_page":50,"daily_write_budget":0,"rate":{"requests_per_minute":100000,"writes_per_minute":100000,"group_creates_per_minute":100000}},"retention_days":365,"push":false}
{"accepted":1,"duplicates":0,"seq":1,"epoch":"VNQqhBoRLlq7Dvd7odF8Jw"}
{"events":[{"seq":1,"id":"waxVrr-3SxjKe56OgC-TKA","v":1,"n":"7gzelImjbsGCEbu9c52NESKRTlvt_YG6","c":"a5QIlENnOWfg…"}],"next":1,"more":false,"epoch":"VNQqhBoRLlq7Dvd7odF8Jw"}
204
{"accepted":1,"duplicates":0,"seq":1,"epoch":"bPJM2j4OahN0JZeTsUeRGg"}
{"error":"invalid_envelope","message":"id must be 22 base64url characters","index":1} 400
{"error":"unauthorized","message":"token does not match groupId"} 401
```

After the delete, the same envelope is accepted again at `seq` 1 under a new epoch (§6.4, §6.6).

## Running the conformance suite

The suite needs small caps and high rate limits (`conformance/README.md`). They live in the `test` environment in
`wrangler.jsonc`, which has its own vars, its own rate-limiter thresholds, and its own local database (`even-test`),
so a conformance run never touches development data:

```sh
npm run dev:test        # = db:schema:test && db:seed:test && wrangler dev --env test --port 8787

# in another shell
npm run conformance     # = cd ../conformance && EVEN_SERVER_URL=http://127.0.0.1:8787 npx vitest run
```

Why an environment rather than `wrangler dev --var …`: `/v1/info` is built from the `limits` table, so the table has
to be re-seeded with the test values anyway, and the rate-limiter thresholds are binding configuration that `--var`
cannot change. `wrangler dev` enforces those bindings locally (a run against the default 120/minute gets `429`s), so
the test values must reach them too. `npm run db:seed:test` seeds from `env.test.vars` and checks the thresholds
match.

Result against this Worker: **164 passed, 6 skipped** (the two opt-in tests and their cases), and with the
blocked-group opt-in below, **169 passed, 1 skipped** (the rate-limit test).

Blocked-group opt-in, while `npm run dev:test` is running:

```sh
ID=$(cd ../conformance && EVEN_SERVER_URL=http://127.0.0.1:8787 npm run --silent blocked-id)
npx wrangler d1 execute even-test --local --env test \
  --command "INSERT OR IGNORE INTO blocked (group_id, blocked_at) VALUES ('$ID', 0)"
(cd ../conformance && EVEN_SERVER_URL=http://127.0.0.1:8787 EVEN_CONFORMANCE_BLOCKED_GROUP_ID=$ID npx vitest run)
```

The rate-limit opt-in (`EVEN_CONFORMANCE_RATE=1`) needs the test caps together with a small
`EVEN_RATE_REQUESTS_PER_MINUTE` (and the same `RATE_REQUESTS` threshold), for example 60. It passes against the local
limiter with that configuration; it is not wired into `dev:test` because it would throttle the rest of the suite.

## Configuration

Every limit is a var in `wrangler.jsonc`, with the same names and defaults as the Python reference:

| Var | Default | Enforced where |
|---|---|---|
| `EVEN_MAX_EVENT_BYTES` | `8192` | envelope validation |
| `EVEN_MAX_GROUP_BYTES` | `2097152` | `events_cap` trigger (sum of decoded `c` + 64) |
| `EVEN_MAX_GROUP_EVENTS` | `10000` | `events_cap` trigger |
| `EVEN_MAX_BATCH` | `25` | append body |
| `EVEN_MAX_PAGE` | `500` | read `limit` clamp |
| `EVEN_RETENTION_DAYS` | `365` | expiry cron |
| `EVEN_RATE_REQUESTS_PER_MINUTE` | `120` | `RATE_REQUESTS` binding, every request to a documented route |
| `EVEN_RATE_WRITES_PER_MINUTE` | `60` | `RATE_WRITES` binding, appends |
| `EVEN_RATE_GROUP_CREATES_PER_MINUTE` | `3` | `RATE_CREATES` binding, appends to a group with no row yet |
| `EVEN_DAILY_WRITE_BUDGET` | `0` (off) | appends, all groups; set it on the public server |
| `EVEN_OPERATOR` | empty | `/v1/info` `operator` |
| `EVEN_TERMS_URL` | empty | `/v1/info` `terms` |

`EVEN_TRUST_PROXY_HEADER` is Python-only: the Worker always keys rate limits by `CF-Connecting-IP`, which Cloudflare
sets itself.

**The vars are not read at request time.** `scripts/seed-limits.mjs` turns them into `seed-limits.sql`, and applying
that writes the `limits` table. `/v1/info`, the handlers and the `events_cap` trigger all read the table, so what is
published is exactly what is enforced. A missing row fails closed: requests get `500 server_error` and the log line
`{"event":"limits_missing","missing":[…]}`, and the trigger treats a missing cap as 0. If the table differs from the
deployed vars (a var changed without re-seeding), the Worker logs `limits_table_differs_from_vars` once per isolate
and keeps using the table.

### Changing a limit

1. Edit the var in `wrangler.jsonc`. For a rate, also set the matching binding's `simple.limit` to the same number;
   the seed script refuses to run while they differ.
2. `npm run db:seed:remote`: the new value is published and, for caps and page/batch sizes, enforced from this moment.
3. `npm run deploy`: needed for rate changes (the binding threshold ships with the deploy) and to keep the vars in step.

Locally, `npm run db:seed` (or `db:seed:test`) is step 2; `wrangler dev` picks up config edits by itself.

## Deploy

```sh
npx wrangler login
npx wrangler d1 create even          # paste the printed database_id into d1_databases in wrangler.jsonc
npm run db:schema:remote             # tables and triggers (idempotent)
npm run db:seed:remote               # the limits table, from the top-level vars
npm run deploy
```

Then add the custom domain (`sync.even.appalaya.com`) to the Worker in the dashboard, and for the public server set
`EVEN_DAILY_WRITE_BUDGET`, `EVEN_OPERATOR` and `EVEN_TERMS_URL` (then re-seed and deploy). Each `ratelimits`
`namespace_id` must be unique within the account; change them if another Worker already uses 4101–4103.

The `test` environment can be deployed as a staging server for running the conformance suite against real
infrastructure: create a database for it, replace its `local-even-test` id, apply `schema.sql`, seed with
`node scripts/seed-limits.mjs --env test`, and `npx wrangler deploy --env test`.

A note on raising `EVEN_MAX_BATCH`: an append is one prelude batch (4 statements) plus one write batch
(`max_batch` + 3), plus 2 more on a `413`. If D1 counts each batched statement toward the per-invocation query
limit (50 on the free plan), the default of 25 leaves room and much above 40 would not; check the current D1 limits
before raising it.

## Takedown (blocklist)

A blocked group id answers `410 group_blocked` on every group route (after authentication), which clients treat as
terminal. A plain delete is pointless: the next member who syncs recreates the group.

```sh
# block (the 43-character id from the request path, e.g. as given in an abuse report)
npx wrangler d1 execute even --remote --command \
  "INSERT OR IGNORE INTO blocked (group_id, blocked_at) VALUES ('<groupId>', unixepoch() * 1000)"
# optionally purge what is stored now (otherwise expiry deletes it)
npx wrangler d1 execute even --remote --command \
  "DELETE FROM events WHERE group_id = '<groupId>'; DELETE FROM groups WHERE id = '<groupId>'"
# unblock
npx wrangler d1 execute even --remote --command "DELETE FROM blocked WHERE group_id = '<groupId>'"
```

Use `--local` instead of `--remote` for the local database.

## Expiry

A cron trigger (`17 3 * * *`, daily) deletes groups with no successful write for `retention_days` (read from the
`limits` table, the value `/v1/info` publishes), their events, and daily counters older than a week. Reads do not
keep a group alive. If the `retention_days` row is missing, it deletes nothing and logs `expiry_skipped`.

Try it locally with `npx wrangler dev --test-scheduled`, then `curl "http://127.0.0.1:8787/__scheduled?cron=17+3+*+*+*"`;
the log shows `{"level":"info","event":"expiry","groups_deleted":…,"retention_days":…}`.

## Rate limits and the daily budget

- Three Workers Rate Limiting bindings with 60-second periods, keyed by `CF-Connecting-IP` (IPv6 by /64). A `429`
  carries `Retry-After: 60`, the binding's period, since the binding does not report when its window ends. The
  platform's limits are approximate and per Cloudflare location, which is fine for abuse control.
- The creation limiter is consulted only when the group had no row at the start of the request; the write limiter
  only on appends; authentication runs first, so an unauthenticated flood consumes nothing for a real group.
- A missing binding, or a limiter call that throws, allows the request and logs `ratelimit_binding_missing` /
  `ratelimit_binding_failed` once per isolate, so a self-deployed Worker without the bindings still works.
- The daily write budget counts append requests per UTC day in `counters`, incremented inside the append batch
  (rolled back with it on `413`). Past the budget, appends get `503 over_budget` with `Retry-After` until UTC
  midnight; reads continue. The check uses the count read at the start of the request, so concurrent appends at the
  boundary can overshoot by the number in flight. For a quota guard that is immaterial; the per-group caps, by
  contrast, are exact because the trigger enforces them inside the batch.

## Logging and privacy

The Worker writes one JSON line per request, `{"method","route","status","ms","limited"}`, where `route` is the
pattern (`/v1/groups/{groupId}/events`) or `null` for a 404. It never logs a URL, token, body, group id or IP.
Operational lines (`expiry`, `limits_missing`, `ratelimit_binding_missing`, `unhandled_exception` with the exception
type only) follow the same rule. `ms` is wall time, which in Workers advances only across I/O.

In `wrangler.jsonc`, Workers Logs keeps those lines, but **invocation logs are off** (they record the request URL),
traces are off, and Logpush is off. What remains outside this code's control, and must be disclosed in the public
server's terms (PROTOCOL.md §9):

- Cloudflare terminates TLS and sees full URLs, tokens and IPs in flight, and keeps its own platform analytics.
- `npx wrangler tail` streams live invocations including request URLs to whoever runs it. It is not persisted, but do
  not pipe it to a file.
- `wrangler dev` prints each request URL to your terminal (`[wrangler:info] POST /v1/groups/…/events 200`). Local only.

## What local runs cannot show

- **The real rate limiter.** Locally, `wrangler dev` simulates the bindings (a single process, exact counts). On
  Cloudflare they are per location and eventually consistent. The code path is the same, a missing binding is
  guarded (allow and log once), and the unit tests cover allow/deny/missing/throwing with fakes.
- **Cron on Cloudflare.** The schedule itself only fires when deployed; the handler is exercised by the tests and by
  `--test-scheduled` locally.
- **D1 in production**: network latency, the per-invocation query limit and CPU limits of the plan. The batch shapes
  are the same as locally; the note on `EVEN_MAX_BATCH` above is the one limit that interacts with them.
- **Observability settings.** That invocation logs, traces and Logpush stay off can only be checked in the dashboard
  after a deploy.
- **Deploy itself**, the custom domain, and `database_id` / `namespace_id` values, which need an account.
