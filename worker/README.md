# Even sync server: Cloudflare Workers + D1 reference

The Worker that runs the public server at `https://sync.even.appalaya.com`, deployed from `main` by GitHub Actions
([Deploying](#deploying)). It implements [`PROTOCOL.md`](../PROTOCOL.md) v1: it stores client-encrypted envelopes
per group, hands them back in order, and cannot read any of them. It passes the [conformance suite](../conformance/)
(below).

Outside the protocol it answers two fixed plain-text pages, before any rate limiter or D1 read: `GET /robots.txt`
(`Disallow: /` for every crawler) and `GET /` (what the host is, with a link to this repository). Both carry
`X-Robots-Tag: noindex, nofollow` and, like every response, `Cache-Control: no-store`. Every other path outside `/v1`
is `404 not_found`.

No framework and no runtime dependencies. Dev dependencies are `wrangler`, `typescript`,
`@cloudflare/workers-types`, `vitest` and `@cloudflare/vitest-pool-workers`. Node 24 or newer.

```
wrangler.jsonc          D1 binding, four rate limiters, cron, EVEN_* vars, observability (invocation logs off),
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
under concurrent appends), the blocklist, the rate-limit paths (with fake bindings), the rows an event read is
charged for, the log lines, and expiry. The conformance suite remains the definition of correctness.

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
{"protocol":[1],"limits":{"max_event_bytes":8192,"max_group_bytes":65536,"max_group_events":200,"max_batch":25,"max_page":50,"daily_write_budget":0,"rate":{"requests_per_minute":100000,"writes_per_minute":100000,"group_creates_per_minute":100000,"reads_per_minute":100000}},"retention_days":365,"push":false}
{"accepted":1,"duplicates":0,"seq":1,"epoch":"IaLWA4Bj3bRP2wz060lm9g","received_at":[1790985001337]}
{"events":[{"seq":1,"id":"MiCWbbM7tCAhFP9EPOmwTg","v":1,"n":"QGxbHmCaxCvkPhJSblR32JcpLky7bWbU","c":"nBZiuSj_CNbr…","received_at":1790985001337}],"next":1,"more":false,"epoch":"IaLWA4Bj3bRP2wz060lm9g"}
204
{"accepted":1,"duplicates":0,"seq":1,"epoch":"f4mmtZ36WWnTanq489qmxQ","received_at":[1790985001375]}
{"error":"invalid_envelope","message":"id must be 22 base64url characters","index":1} 400
{"error":"unauthorized","message":"token does not match groupId"} 401
```

After the delete, the same envelope is accepted again at `seq` 1 under a new epoch (§6.4, §6.6), with a new
`received_at`: the time this server stored it, in Unix milliseconds, one value per append request (§4, §6.2).

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
npx wrangler@4.141.0 d1 execute even-test --local --env test \
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
| `EVEN_RATE_READS_PER_MINUTE` | `720`; **`120`** in `wrangler.jsonc`, the public server ([why](#event-reads-per-address)) | `RATE_READS` binding, event reads (`GET …/events`) in units of 100 D1 rows read |
| `EVEN_DAILY_WRITE_BUDGET` | `50000` ([why](#the-daily-write-budget)); `0` turns it off | `counters_budget` triggers, events stored per UTC day (duplicates not counted), all groups |
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
`ratelimits` `namespace_id` must be unique within the account; change them if another Worker already uses 4101–4104.

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
   every run: the schema is `CREATE … IF NOT EXISTS` (it adds what is missing, such as a new index or trigger, and
   leaves data alone) except `events_count`, which it drops and creates again so that its current definition wins,
   and the seed is one upsert per limit. D1 runs a `--file` as an import, which is atomic;
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
request), the cron trigger (5 per account on Free; this uses 1), the four Rate Limiting bindings (Cloudflare's
documentation lists no plan requirement or price for them), Workers Logs (200,000 events a day, kept 3 days) and
D1 (500 MB per database, 50 queries per invocation, 5 million rows read and 100,000 rows written a day). Past a
daily D1 limit, every query, reads included, fails until 00:00 UTC and the Worker answers `500`;
`EVEN_DAILY_WRITE_BUDGET` is how to stop appends before that. Logpush and traces, which are off for privacy anyway,
are not needed.

### The daily write budget

The public server stores at most **50,000 events per UTC day**, across all groups (`EVEN_DAILY_WRITE_BUDGET`,
published as `limits.daily_write_budget`). It counts events stored, not append requests: an append of eight new
events counts eight, and an envelope the group already holds counts nothing, so a device re-pushing what another
device already stored costs nothing. A whole day at the budget writes at most about half of D1's free 100,000 rows,
whatever shape the appends take.

D1 counts one row written per table row inserted, updated or deleted, plus one per index entry the write touches.
What one append writes, measured as `meta.rows_written` of the Worker's own batch against local D1 (and pinned by
a test in `test/worker.test.ts`):

| Statement in the append batch | Rows written |
|---|---:|
| the day's counter: the first counted append of the UTC day inserts it (row + primary-key index) | 2 |
| the day's counter: every later append that stores at least one event updates it | 1 |
| the day's counter, when every envelope is a duplicate (the statement inserts and updates nothing) | 0 |
| the group row, only when the group is new (row + primary-key index + `last_write_at` index) | 3 |
| the group's `last_write_at`, once per append to an existing group that stores anything (row + its index entry) | 2 |
| each new event: the row, its two indexes `(group_id, seq)` and `(group_id, id)`, and the `events_count` trigger's update of the group's counts | 4 |
| each duplicate event (`INSERT OR IGNORE` that inserts nothing) | 0 |

An event therefore costs 4 rows plus its append's overhead: 1 for the counter, and 3 more when the append creates
its group or 2 when it does not. The dearest day is one where every event arrives alone, each in a new group:
8 rows an event. Sized on 2 October 2026 for Workers Paid: the worst day writes **8 × 50,000 + 1 = 400,001** rows, about a quarter of
the plan's included 50 million rows a month spread over 30 days; on the earlier Free plan the budget was 6,500 (52% of its 100,000 rows a day).
append requests (500 × 104 = 52,000) allowed. Every other shape costs less:

| A day of 50,000 events, all arriving as | Rows written | Of 1.67 M (50 M a month ÷ 30) |
|---|---:|---:|
| one-event appends, each creating a group | 8 × 50,000 + 1 = 400,001 | 24% |
| one-event appends to existing groups | 7 × 50,000 + 1 = 350,001 | 21% |
| full 25-event appends to existing groups | 2,000 × 103 + 1 = 206,001 | 12% |

The budget is not sized at 4 rows an event (about 15,000 a day for the same share): a day of one-event appends to
new groups would then write 120,001 rows and pass the limit. What 50,000 means in use: a group re-pushed in full after
an epoch change (expiry, a deleted server copy, a move to this server) costs its event count once, since every other
device's re-push is duplicates; a 3,400-event group takes 52% of a day, and a group at the 10,000-event cap needs
two days.

The other 48,000 rows are for writes the budget does not count: deleting a group (`DELETE /v1/groups/{groupId}`), the
daily expiry (at most about 10,000 rows a run, plus one group; [Expiry](#expiry)), and the 11 upserts of each
deploy's seed. A delete writes one row per event and one for the group as measured locally; if D1 also counts the
deleted index entries, as its documentation suggests, it is up to 3 per event and 3 for the group. A group at the
10,000-event cap costs 10,001 to 30,003 rows. Deletes are bounded by what is stored, not by the budget, so a day of several deletes
of full groups can still reach the limit. Reads are not the constraint for appends: measured locally, an append's
batch reads about 13 rows per new event plus 10 (21 to 23 for a one-event append), and its prelude 12 more, so a day
at the budget reads at most about 50,000 × 35 = 1.75 million rows (all one-event appends to existing groups), 35% of
the Free plan's 5 million a day. An append of duplicates only writes nothing and is not counted, but still reads
about 11 rows per envelope (it looks up each id's stored `received_at` to report it); those are bounded per address
by `EVEN_RATE_WRITES_PER_MINUTE`, not by the budget.

To change the budget, edit the var and merge ([Changing a limit](#changing-a-limit)); the next deploy seeds it, and
`/v1/info` publishes it as `limits.daily_write_budget`. Size it in events, with 8 rows written per event as the worst
case.

### Event reads per address

D1's free 5 million rows read a day are the other quota one client could spend. What an event read reads, measured as
`meta.rows_read` on local D1 (and pinned by a test in `test/worker.test.ts`):

| Part of `GET /v1/groups/{groupId}/events` | Rows read |
|---|---:|
| the prelude: the 11 rows of the `limits` table, and the group row (0 for a group with no row) | 12 |
| the group's epoch (0 without a row) | 1 |
| the events after `since`, up to `limit` | 0 to `limit` |
| one more: the look-ahead row that sets `more`, or the index entry where the scan stops | 1 |

A poll of a group with nothing new reads 14 rows; a full page (`max_page` 500, more to come) reads 12 + 1 + 500 + 1 =
514. At the 120 requests a minute every route allows, one address reading full pages would spend the day's reads in 81
minutes, after which D1 refuses every query until 00:00 UTC.

So event reads have their own allowance per address, counted in **units of 100 rows**: a read costs ceil(rows / 100)
units, at least 1, so a read of E events costs ceil((14 + E) / 100): a quiet poll or a read of up to 86 events costs
1, and a full page costs 6. The public server allows **120 units a minute** (`EVEN_RATE_READS_PER_MINUTE` and the `RATE_READS`
binding; `/v1/info` publishes it as `limits.rate.reads_per_minute`). Every unit pays for at most 100 rows, so a whole
day at the allowance reads at most 120 × 100 × 1,440 = **17,280,000 rows**, about 2% of the paid plan's 25 billion a month
(it was 25 units, 3.6 million rows and 72% of the free plan's 5 million a day, until Workers Paid on 2 October 2026), whatever size the reads
are. The published name stays: a read of up to 100 rows is one read, and only larger ones count more. The default
for a self-hosted Worker is 720, 120 full pages a minute, which adds nothing to the request limit.

How a read is charged. The binding has no weight, so each unit is one `limit({ key })` call, and a unit once taken
cannot be given back. The first unit is taken with the request limiter, before any D1 read, so an address with
nothing left costs no rows at all. The rest are taken after the prelude and before the events are read: the group
row the prelude reads holds the group's event count, and `seq` runs 1..count within an epoch (events are deleted
only together with their group), so how many events follow `since`, and so the cost, is known before the page is
read (`readRows` in `src/db.ts`; it counts the extra row even where D1 does not, so it never counts too few). If
the allowance runs out partway, the read is refused with `429` and `Retry-After: 60` and reads nothing more, and the
units it did take stay spent, which uses up the address's minute: a refused client reads no further page until the
minute is over, however many reads it has in flight. The rows of a refused read (its prelude, 12) are paid by its
first unit. Two small exceptions: events appended between the prelude and the read are read without being counted
(at most what is appended in those milliseconds; the daily write budget caps all appends at 50,000 events a day), and
a read is never charged more than the whole allowance, so that a full page always fits in a fresh minute even if
`EVEN_MAX_PAGE` is raised past what `EVEN_RATE_READS_PER_MINUTE` covers. Size the two together: a full page costs
ceil((`max_page` + 14) / 100) units.

What it means for a client: 120 quiet polls a minute per address. A phone that syncs six groups when it opens uses 6,
so twenty phones behind one address (a household, an office, a mobile carrier's NAT) can open the app in the same
minute before the next waits out a `429`; on a carrier that gives phones IPv6, each phone has its own /64 and its
own 120. A download reads 20 full pages a minute (120 units), 10,000 events, so a group at the 10,000-event cap takes
about a minute. A `429` is transient: clients wait `Retry-After` and carry on (PROTOCOL.md §10).

The worst case depends on the allowance alone: N units a minute is at most N × 144,000 rows a day. On the free plan 34
was the most that stayed under its 5 million a day (4,896,000); on Workers Paid the ceiling is a bill, not a cutoff: 120 units
is about 17 million rows a day from one address, roughly two cents at the plan's read price.

What the read limit does not cover, so that per-IP limits alone still cannot hold one determined client under the
quota:

- Every other request reads too: 12 rows in a group route's prelude, 11 for `/v1/info`. At 120 a minute that is up
  to 2,073,600 rows a day from one address without reading a single event, and about 5.6 million together with
  reads at the allowance (five reads of 500 rows, then 115 other requests a minute).
- An append of 25 duplicates stores nothing and is not counted by the budget, but reads about 140 rows with its
  prelude; at `EVEN_RATE_WRITES_PER_MINUTE` (60 a minute) that is about 12 million rows a day.
- Many addresses: every limit here is per address.

Holding those takes a rate rule in front of the Worker, or a paid plan (next section).

### The Workers request cap

The per-IP limits do not protect the Workers Free cap of 100,000 requests a day, and are not meant to. One client
at `EVEN_RATE_REQUESTS_PER_MINUTE` (120) could make 172,800 requests a day and use the whole cap in about 14 hours;
holding one address under it would need 69 a minute or fewer, and two addresses would still reach it. Past the cap
Cloudflare answers error 1027 until 00:00 UTC: a quiet day, not a bill. Neither the budget nor the per-IP limits
can prevent that; a rate-limiting rule on the hostname `sync.even.appalaya.com` (dashboard: **Security → WAF → Rate
limiting rules**) acts before the Worker runs, and is the account owner's to set up. The Free plan offers rate
limiting rules in a limited form; check the current limits when creating one. The landing site's contact Worker
shares the account's cap.

## Takedown (blocklist)

A blocked group id answers `410 group_blocked` on every group route (after authentication), which clients treat as
terminal. A plain delete is pointless: the next member who syncs recreates the group.

Production's database is only on Cloudflare. Run the SQL below in the `even` database's Console in the dashboard
(D1), or with Wrangler from a machine logged in to the account (`npx wrangler@4.141.0 login`); `--remote` finds the database
by name, so the id-free `wrangler.jsonc` works as it is. Neither is a deploy, and neither needs one.

```sh
# block (the 43-character id from the request path, e.g. as given in an abuse report)
npx wrangler@4.141.0 d1 execute even --remote --command \
  "INSERT OR IGNORE INTO blocked (group_id, blocked_at) VALUES ('<groupId>', unixepoch() * 1000)"
# optionally purge what is stored now (otherwise expiry deletes it)
npx wrangler@4.141.0 d1 execute even --remote --command \
  "DELETE FROM events WHERE group_id = '<groupId>'; DELETE FROM groups WHERE id = '<groupId>'"
# unblock
npx wrangler@4.141.0 d1 execute even --remote --command "DELETE FROM blocked WHERE group_id = '<groupId>'"
```

Use `--local` instead of `--remote` for the local database.

## Expiry

A cron trigger (`17 3 * * *`, daily) deletes groups with no successful write for `retention_days` (read from the
`limits` table, the value `/v1/info` publishes), their events, and daily counters older than a week. Reads do not
keep a group alive. If the `retention_days` row is missing, it deletes nothing and logs `expiry_skipped`.

A run is bounded, so a backlog (a year after a busy month, say) cannot become one transaction too large for D1 or
the day's 100,000 rows written, failing every day and never expiring anything. It deletes whole groups, oldest first,
in batches of at most 100 groups and about 1,000 events (a group larger than that goes alone; a group is never split,
since a group left alive with part of its log would keep its epoch). It stops when nothing idle is left, after 20
batches, or once it has written 10,000 rows, and the next day's run carries on. The bounds are `EXPIRY_BOUNDS` in
`src/db.ts`; raise them on a paid plan. The groups are found through the `groups_last_write_at` index, so a run reads
only what it deletes.

Try it locally with `npx wrangler@4.141.0 dev --test-scheduled`, then `curl "http://127.0.0.1:8787/__scheduled?cron=17+3+*+*+*"`;
the log shows `{"level":"info","event":"expiry","groups_deleted":…,"rows_written":…,"complete":true,"retention_days":…}`
(`complete: false` means idle groups were left for the next run).

## Rate limits and the daily budget

- Four Workers Rate Limiting bindings with 60-second periods, keyed by `CF-Connecting-IP` (IPv6 by /64): every
  request, appends, group creations, and event reads, which count one call per unit of 100 rows
  ([why](#event-reads-per-address)). A `429` carries `Retry-After: 60`, the binding's period, since the binding
  does not report when its window ends. The platform's limits are approximate and per Cloudflare location, which is
  fine for abuse control.
- The order is: authentication, the request limiter (and for an event read the first unit of the read limiter),
  then D1 (`/v1/info`: the limiter, then the `limits` table). An unauthenticated flood consumes no limiter for a
  real group, and a refused request costs no D1 rows: the thresholds are binding configuration, so nothing is read
  to apply them. An event read takes the rest of its units after the prelude, before its events are read. A
  blocked group's requests count like any other, so past the limit they get `429` rather than `410`.
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
Operational lines (`expiry`, `limits_missing`, `ratelimit_binding_missing`, `arrival_ahead`, `unhandled_exception`
with the exception type only) follow the same rule. `ms` is wall time, which in Workers advances only across I/O.

In `wrangler.jsonc`, Workers Logs keeps those lines, but **invocation logs are off** (they record the request URL),
traces are off, and Logpush is off. What remains outside this code's control, and must be disclosed in the public
server's terms (PROTOCOL.md §9):

- Cloudflare terminates TLS and sees full URLs, tokens and IPs in flight, and keeps its own platform analytics.
- `npx wrangler@4.141.0 tail` streams live invocations including request URLs to whoever runs it. It is not persisted, but do
  not pipe it to a file.
- `wrangler dev` prints each request URL to your terminal (`[wrangler:info] POST /v1/groups/…/events 200`). Local only.

## Alerts

When an alert fires, or a report or a bad day arrives, follow the operations runbook, even-app
[`docs/runbook.md`](https://github.com/appalaya/even-app/blob/main/docs/runbook.md). It has numbered steps for
takedowns, budget days, 429 floods, D1 limits, redeploys and rollbacks.

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

### When a group's arrival clock runs ahead

A group's arrival time (`groups.last_write_at`, `received_at` on its events) is `MAX(now, last_write_at + 1)`
(`ADVANCE_ARRIVAL` in `src/db.ts`), so one forward jump of the server's clock leaves it ahead of real time for
good: `now` on every later append stays below it, so the server keeps advancing it by 1 ms instead of catching up.
That silently disables the clients' hold for that group (PROTOCOL.md §9, "Clock") and delays its expiry.
After an append that stores at least one event, if the group's `last_write_at` ends up more than 60,000 ms ahead of
`now`, the Worker logs one line, no group id or address:

```
{"level":"warn","event":"arrival_ahead","ahead_ms":123456,"route":"/v1/groups/{groupId}/events"}
```

To see it, open **Workers & Pages → even-sync → Observability** and search `arrival_ahead`; Workers Logs keeps 3
days on Free. It recurs on every later append to the same group that stores something, since the clock jump is
never undone by itself; it clears only if the group is deleted and recreated, or the server's clock catches up to
what it was skewed to and stays there.

### When the budget trips

The Worker's only `503` is `over_budget`. It writes no separate event, only its request line:

```
{"method":"POST","route":"/v1/groups/{groupId}/events","status":503,"ms":…,"limited":false}
```

To see it, open **Workers & Pages → even-sync → Observability** and search for `"status":503`; Workers Logs keeps 3
days on Free. The count behind it is in D1: in **D1 → even → Console**, run
`SELECT day, writes FROM counters ORDER BY day DESC` (a week of days is kept; `writes` is events stored). A day
that tripped reads at most the budget, `50000`, and never more, because the triggers refuse any count past it. It can
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
