# Even sync server: Cloudflare Workers + D1 reference

The Worker that runs the public server at `https://sync.even.appalaya.com`, deployed from `main` by GitHub Actions
([Deploying](#deploying)). It implements [`PROTOCOL.md`](../PROTOCOL.md) v1: it stores client-encrypted envelopes
per group, hands them back in order, and cannot read any of them. It passes the [conformance suite](../conformance/)
(below).

No framework and no runtime dependencies. Dev dependencies are `wrangler`, `typescript`,
`@cloudflare/workers-types`, `vitest` and `@cloudflare/vitest-pool-workers`. Node 24 or newer.

```
wrangler.jsonc          D1 binding, three rate limiters, cron, EVEN_* vars, observability (invocation logs off),
                        workers.dev off
schema.sql              tables and the cap, accounting and daily-budget triggers (design.md, "Storage model")
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
the triggers (including fail-closed when a cap row is missing), the daily budget (events stored, not appends; exact
under concurrent appends),
the blocklist, the rate-limit paths
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
| `EVEN_DAILY_WRITE_BUDGET` | `0` (off); **`7400`** in `wrangler.jsonc`, the public server ([why](#the-daily-write-budget)) | `counters_budget` triggers, events stored per UTC day (duplicates not counted), all groups |
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
2. Merge to `main`. The deploy re-seeds the `limits` table from the vars, which publishes and enforces the new value,
   then deploys the Worker, which ships a changed rate-limiter threshold. The run's summary lists the seeded limits,
   and the run fails if `/v1/info` does not publish exactly those.

Locally, `npm run db:seed` (or `db:seed:test`) does the seeding; `wrangler dev` picks up config edits by itself.

For the public server, set `EVEN_OPERATOR` and `EVEN_TERMS_URL` this way (`EVEN_DAILY_WRITE_BUDGET` is set). Each
`ratelimits` `namespace_id` must be unique within the account; change them if another Worker already uses 4101–4103.

A note on raising `EVEN_MAX_BATCH`: an append is one prelude batch (3 statements) plus one write batch
(`max_batch` + 3), plus 2 more on a `413`. If D1 counts each batched statement toward the per-invocation query
limit (50 on the free plan), the default of 25 leaves room and much above 40 would not; check the current D1 limits
before raising it.

## Deploying

The public server is deployed by GitHub Actions and nothing else:
[`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml). There is no deploy script to run locally. A push
to `main` that changes `worker/` or the workflow deploys, and so does **Run workflow** on the Deploy workflow in the
Actions tab (it deploys `main` only). A running deploy always finishes; the next one waits for it.

A run, in order:

1. `npm ci`, typecheck, unit tests, `node scripts/seed-limits.mjs` (refuses a bad var or a limiter mismatch) and
   `wrangler deploy --dry-run`. Any failure stops the run before Cloudflare is touched.
2. Looks up the D1 database named `even` (`wrangler d1 list --json`) and creates it (`wrangler d1 create even`) if
   the account has none, so the first run needs no preparation. The committed `wrangler.jsonc` has no
   `database_id`: the run adds the id to its own copy of the file (one line, comments kept), and that copy goes
   away with the runner.
3. Applies `schema.sql`, then `seed-limits.sql`, with `wrangler d1 execute even --remote --file`. Both are safe on
   every run: the schema is all `CREATE … IF NOT EXISTS` (it adds what is missing, such as a new trigger, and
   leaves data alone), and the seed is one upsert per limit. D1 runs a `--file` as an import, which is atomic;
   Wrangler warns that the database does not serve queries while an import runs, which for these two small files
   is a moment per deploy.
4. `wrangler deploy --env=""`: the top-level Worker, `even-sync`. `env.test` is for local conformance runs and is
   never deployed.
5. `GET https://sync.even.appalaya.com/v1/info`, compared with the seeded limits, and a job summary with the URL,
   the database, the seeded limits and the response. A failed check or a mismatch fails the run. Until the custom
   domain exists (below), the name does not resolve, and the check is skipped with a notice.

### Secrets

Two repository secrets (Settings → Secrets and variables → Actions), passed only to the steps that call Cloudflare,
never to `npm ci` or the tests:

| Secret | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | an API token with the permissions below |
| `CLOUDFLARE_ACCOUNT_ID` | the Cloudflare account ID (in the dashboard, and in every dashboard URL after `dash.cloudflare.com/`) |

A run without them stops at "Check the Cloudflare secrets", after the tests.

### API token permissions

| Permission | Used for |
|---|---|
| Account · Workers Scripts · Edit | uploading the Worker with its rate-limiter bindings, cron schedule, vars and observability settings; keeping workers.dev and Version URLs off |
| Account · D1 · Edit | `d1 list`, `d1 create`, and `d1 execute --remote` (schema and seed) |

That is everything the deploy uses. It runs with an existing token that has Workers Scripts Edit, Workers KV Storage
Edit and Account Settings Read on the account and Workers Routes Edit on all zones; **D1 Edit is the one addition**.
The other three are unused here (no KV binding, no routes, and with `CLOUDFLARE_ACCOUNT_ID` set Wrangler never looks
the account up). No DNS, zone or SSL permission is needed: the deploy creates no DNS record, route, domain or
certificate. The token editor calls write access "Edit"; Cloudflare's template documentation calls it "Write".

### The custom domain, once

After the first successful run, attach the hostname in the Cloudflare dashboard: **Workers & Pages → even-sync →
Settings → Domains & Routes → Add → Custom Domain → `sync.even.appalaya.com`**. Cloudflare creates the DNS record
and the certificate; nobody edits DNS. To check it straight away, start the workflow by hand: its smoke check now
runs instead of being skipped.

It has to be a Workers custom domain, not a DNS record plus a route. `sync.even.appalaya.com` is a second-level
subdomain, and the zone's free Universal SSL certificate covers only `appalaya.com` and first-level names such as
`even.appalaya.com`. A custom domain gets its own certificate for the exact hostname at no cost and creates its DNS
record itself.

`wrangler.jsonc` deliberately has no `routes`: with none, `wrangler deploy` leaves the Worker's domains alone, so
the attachment survives every deploy. `workers_dev` and `preview_urls` are `false`, so the custom domain is the only
address (without them, a deploy with no routes turns workers.dev on). Until the domain is attached, the deployed
Worker has no public address at all, which is fine: nothing points at it yet.

### What the free plan covers

Everything the deploy turns on runs on the Workers Free plan: the Worker (100,000 requests a day, 10 ms CPU per
request), the cron trigger (5 per account on Free; this uses 1), the three Rate Limiting bindings (Cloudflare's
documentation lists no plan requirement or price for them), Workers Logs (200,000 events a day, kept 3 days) and
D1 (500 MB per database, 50 queries per invocation, 5 million rows read and 100,000 rows written a day). Past a
daily D1 limit, every query, reads included, fails until 00:00 UTC and the Worker answers `500`;
`EVEN_DAILY_WRITE_BUDGET` is how to stop appends before that. Logpush and traces, which are off for privacy anyway,
are not needed.

### The daily write budget

The public server stores at most **7,400 events per UTC day**, across all groups (`EVEN_DAILY_WRITE_BUDGET`,
published as `limits.daily_write_budget`). It counts events stored, not append requests: an append of eight new
events counts eight, and an envelope the group already holds counts nothing, so a device re-pushing what another
device already stored costs nothing. A whole day at the budget writes at most about half of D1's free 100,000 rows,
whatever shape the appends take.

D1 counts one row written per table row inserted, updated or deleted, plus one per index entry the write touches.
What one append writes, measured as `meta.rows_written` of the Worker's own batch against local D1:

| Statement in the append batch | Rows written |
|---|---:|
| the day's counter: the first counted append of the UTC day inserts it (row + primary-key index) | 2 |
| the day's counter: every later append that stores at least one event updates it | 1 |
| the day's counter, when every envelope is a duplicate (the statement inserts and updates nothing) | 0 |
| the group row, only when the group is new (row + primary-key index) | 2 |
| each new event: the row, its two indexes `(group_id, seq)` and `(group_id, id)`, and the `events_count` trigger's update of the group row | 4 |
| each duplicate event (`INSERT OR IGNORE` that inserts nothing) | 0 |

An event therefore costs 4 rows plus its append's overhead: 1 for the counter, and 2 more when the append creates its
group. The dearest day is one where every event arrives alone, each in a new group: 7 rows an event, so
**7 × 7,400 + 1 = 51,801**, 52% of the daily limit, the same share the earlier budget of 500 append requests
(500 × 104 = 52,000) allowed. Every other shape costs less:

| A day of 7,400 events, all arriving as | Rows written | Of 100,000 |
|---|---:|---:|
| one-event appends, each creating a group | 7 × 7,400 + 1 = 51,801 | 52% |
| one-event appends to existing groups | 5 × 7,400 + 1 = 37,001 | 37% |
| full 25-event appends to existing groups | 296 × 101 + 1 = 29,897 | 30% |

The budget is not sized at 4 rows an event (about 15,000 a day for the same share): a day of one-event appends to new
groups would then write 105,001 rows and pass the limit. What 7,400 means in use: a group re-pushed in full after
an epoch change (expiry, a deleted server copy, a move to this server) costs its event count once, since every other
device's re-push is duplicates; a 3,400-event group takes 46% of a day, and a group at the 10,000-event cap needs
two days.

The other 48,000 rows are for writes the budget does not count: deleting a group (`DELETE /v1/groups/{groupId}`), the
daily expiry, and the 10 upserts of each deploy's seed. A delete writes one row per event and one for the group as
measured locally; if D1 also counts the deleted index entries, as its documentation suggests, it is up to 3 per
event. The headroom is 16,000 to 48,000 deleted events a day; a group at the 10,000-event cap costs 10,001 to 30,002
rows. Deletes are bounded by what is stored, not by the budget, so a day of several deletes of full groups can still
reach the limit. Reads are not the constraint for appends: an append reads about 8 rows per new event plus 6, and
about 12 more in its prelude, so a day at the budget reads at most about 200,000 of the 5 million (all one-event
appends). An append of duplicates only writes nothing and is not counted, but still reads about 5 rows per
envelope; those are bounded per address by `EVEN_RATE_WRITES_PER_MINUTE`, not by the budget.

The per-IP limits do not protect the Workers Free cap of 100,000 requests a day, and are not meant to. One client
at `EVEN_RATE_REQUESTS_PER_MINUTE` (120) could make 172,800 requests a day and use the whole cap in about 14 hours;
holding one address under it would need 69 a minute or fewer, and two addresses would still reach it. Past the cap
Cloudflare answers error 1027 until 00:00 UTC: a quiet day, not a bill. D1's 5 million rows read are similar: a
full page (`max_page` 500) reads about 515 rows, so one client reading full pages at 120 a minute would spend the
day's reads in about 80 minutes, and D1 would then refuse every query until 00:00 UTC. The write budget covers
neither.

To change the budget, edit the var and merge ([Changing a limit](#changing-a-limit)); the next deploy seeds it, and
`/v1/info` publishes it as `limits.daily_write_budget`. Size it in events, with 7 rows written per event as the worst
case.

## Takedown (blocklist)

A blocked group id answers `410 group_blocked` on every group route (after authentication), which clients treat as
terminal. A plain delete is pointless: the next member who syncs recreates the group.

Production's database is only on Cloudflare. Run the SQL below in the `even` database's Console in the dashboard
(D1), or with Wrangler from a machine logged in to the account (`npx wrangler login`); `--remote` finds the database
by name, so the id-free `wrangler.jsonc` works as it is. Neither is a deploy, and neither needs one.

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
- The order is: authentication, the request limiter, then D1 (`/v1/info`: the limiter, then the `limits` table). An
  unauthenticated flood consumes no limiter for a real group, and a refused request costs no D1 rows: the thresholds
  are binding configuration, so nothing is read to apply them. A blocked group's requests count like any other, so
  past the limit they get `429` rather than `410`.
- The creation limiter is consulted only when the group had no row at the start of the request; the write limiter
  only on appends.
- A missing binding, or a limiter call that throws, allows the request and logs `ratelimit_binding_missing` /
  `ratelimit_binding_failed` once per isolate, so a self-deployed Worker without the bindings still works.
- The daily write budget counts events stored per UTC day in `counters`, duplicates not counted: the append batch's
  first statement adds the number of the request's envelopes the group does not hold yet (rolled back with the
  batch on `413`). An append whose new events would pass the budget gets `503 over_budget` with `Retry-After` until
  UTC midnight and stores nothing; reads continue, and so does an append of duplicates only. The `counters_budget`
  triggers refuse the count inside the batch, so the budget is exact however many appends are in flight, like the
  per-group caps. There is no separate check in the handler.

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

## Alerts

The deploy's API token cannot create notifications, so the account owner sets these up once, by hand. What the
Free plan offers, per Cloudflare's [available notifications](https://developers.cloudflare.com/notifications/notification-available/)
(checked 2026-10-01):

- **No notification type watches a Worker or D1.** None alerts on a Worker's error rate, its daily requests or D1's
  daily rows. The error-rate alerts (Advanced Error Rate, Origin Error Rate, Traffic Anomalies) are Enterprise
  only, and Usage Based Billing covers billed usage on paid plans; on Free nothing is billed, so it has nothing to
  watch. Free accounts get notifications by email only.
- **Cloudflare incidents: turn this on.** Dashboard → **Notifications** → **Add** → **Incident Alerts** (Cloudflare
  Status) → **Select**. Name it `Even sync: Cloudflare incidents`, pick the components **Workers** and **D1**, keep
  every impact level (minor, major, critical; incidents are rare enough that this is not noisy), enter the email
  address to notify, **Create**. This tells you when an outage is Cloudflare's rather than the Worker's.
- **The daily request cap**: there is nothing to set up. Users report that Cloudflare emails the account when
  Workers requests near and pass the free 100,000 a day; this is not in the documentation and has not been
  checked here. Past the cap, Cloudflare answers error 1027 until 00:00 UTC and the Worker logs nothing.
- **Error-rate alerts through Workers Issues: off, on purpose.** Issues (open beta, free during the beta) records
  every uncaught exception, `5xx` response and logged error, and an automation can send an issue to a webhook or
  chat service once it passes an occurrence threshold (no email). It needs
  `"observability": { "issues": { "enabled": true } }` in `wrangler.jsonc`, and the Issues documentation does not
  say what an occurrence stores. If that includes the request URL, it stores group ids, which
  [THREAT-MODEL.md](../THREAT-MODEL.md), "What we log", rules out. Check that before turning it on; if it passes,
  an occurrence threshold of 1 sends one message for each new kind of failure (a tripped budget included), and
  "recurrence after inactivity" of 24 hours one more when a failure returns after a quiet day.

Without alerts, look in the dashboard: **Workers & Pages → even-sync → Metrics** (requests, errors) and **D1 →
even → Metrics** (rows read and written per day, against the free 5 million and 100,000).

### When the budget trips

The Worker's only `503` is `over_budget`. It writes no separate event, only its request line:

```
{"method":"POST","route":"/v1/groups/{groupId}/events","status":503,"ms":…,"limited":false}
```

To see it, open **Workers & Pages → even-sync → Observability** and search for `"status":503`; Workers Logs keeps 3
days on Free. The count behind it is in D1: in **D1 → even → Console**, run
`SELECT day, writes FROM counters ORDER BY day DESC` (a week of days is kept; `writes` is events stored). A day
that tripped reads at most the budget, `7400`, and never more, because the triggers refuse any count past it. It can
read a little less: an append is refused whole when its new events do not all fit, so the last refused append may
have been larger than what was left (at most `max_batch`, 25).

D1's own daily limits are different: once one is spent, every request that queries D1 answers `500` and logs
`{"level":"error","event":"unhandled_exception","route":…,"exception":…}` until 00:00 UTC.

## What local runs cannot show

- **The real rate limiter.** Locally, `wrangler dev` simulates the bindings (a single process, exact counts). On
  Cloudflare they are per location and eventually consistent. The code path is the same, a missing binding is
  guarded (allow and log once), and the unit tests cover allow/deny/missing/throwing with fakes.
- **Cron on Cloudflare.** The schedule itself only fires when deployed; the handler is exercised by the tests and by
  `--test-scheduled` locally.
- **D1 in production**: network latency, the per-invocation query limit and CPU limits of the plan. The batch shapes
  are the same as locally; the note on `EVEN_MAX_BATCH` above is the one limit that interacts with them.
- **Observability settings.** That invocation logs, traces and Logpush stay off can only be checked in the dashboard
  after a deploy. Check there too that the Worker's own log events carry no request URL in the metadata Workers Logs
  attaches to them (Cloudflare's documentation does not say either way); if one does, set
  `observability.logs.enabled` to `false` and rely on `wrangler tail` for live debugging.
- **The deploy itself**: finding or creating the database, the remote schema and seed, and `wrangler deploy` run
  only in the workflow, with the account's token; the custom domain is attached once, by hand.
