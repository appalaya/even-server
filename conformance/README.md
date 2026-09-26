# Even protocol conformance suite

An executable test suite for [PROTOCOL.md](../PROTOCOL.md). **A server that passes it is an Even server**
(PROTOCOL.md §12). It runs against any URL, needs nothing from the server but HTTP, and does not care which
language the server is written in.

The suite derives tokens and group ids exactly as the app does (§2) and seals real XChaCha20-Poly1305 envelopes
(§3), so it doubles as an independent implementation of the client-side crypto. A known-answer test pins that
implementation to the vectors in the app's `packages/core` tests, so the two cannot drift.

## Run it

Node 24 or newer.

```sh
cd conformance
npm install
EVEN_SERVER_URL=http://127.0.0.1:8787 npx vitest run     # or: EVEN_SERVER_URL=… npm test
npm run typecheck
```

`EVEN_SERVER_URL` is required. Without it the run fails immediately with instructions and makes no requests. The URL
may include a path (`https://home.example.net:8443/even`); requests go to `<url>/v1/…`.

**`http://` is accepted only for `localhost` and `127.0.0.1`.** The app never speaks plain http to a server (§5);
the suite is a test tool, and an unencrypted local port is how you test a server on your own machine. Any other host
must be `https://`.

The §2/§3 known-answer tests need no server: `npx vitest run --project kat`.

## The server must run with test limits

Cap tests fill a group to its byte and event caps, so they need small caps. **The suite refuses to report success**
against a server whose `/v1/info` publishes `max_group_bytes > 65536` or `max_group_events > 200`. It fails the whole
run before any test executes and says which values to change. It also requires `max_page ≤ max_group_events − 3`,
because the paging test stores more than one page in a single group. Rate limits should be high: every test creates
its own group. The client waits out 429s (`Retry-After`), so low rate limits make a run slow rather than wrong, but
tests can then hit their timeout. The preflight warns when that is likely.

Use these values for test runs. Both reference servers read the same names:

| Variable | Test value | Why |
|---|---|---|
| `EVEN_MAX_GROUP_BYTES` | `65536` | required: ≤ 65536 |
| `EVEN_MAX_GROUP_EVENTS` | `200` | required: ≤ 200 |
| `EVEN_MAX_PAGE` | `50` | required: ≤ `max_group_events − 3` (the default of 500 is too large) |
| `EVEN_RATE_REQUESTS_PER_MINUTE` | `100000` | the suite makes a few hundred requests in seconds |
| `EVEN_RATE_WRITES_PER_MINUTE` | `100000` | |
| `EVEN_RATE_GROUP_CREATES_PER_MINUTE` | `100000` | one new group per test |
| `EVEN_DAILY_WRITE_BUDGET` | `0` | a budget can run out mid-run (`503 over_budget`) |

Leave `EVEN_MAX_EVENT_BYTES` and `EVEN_MAX_BATCH` at their defaults or change them. The suite reads `max_event_bytes`,
`max_batch`, `max_page` and both caps from `/v1/info` and tests against the published values, never hard-coded ones.
Public servers are tested through a staging deployment configured this way.

## What "passing" means

- Every test passes (`0 failed`) in a run against a server configured with test limits. The run exits 0.
- Two tests are opt-in and skipped by default, because only an operator can arrange them:
  - **blocked group** (§9 blocking is a MAY). If the server supports blocking, run this test too (below).
  - **rate limiting** (§9 SHOULD). Limits are per IP and may be enforced approximately, so it is not run by default.
- A skipped test is not a failure. A run in which only the opt-in tests are skipped is a pass of the core protocol.

Every test creates a fresh group from a new random secret. Tests are independent, test files run in parallel, and
no test assumes an empty database, so you can run the suite repeatedly against a long-lived instance.

Besides its own assertions, every test also checks every response it receives against §5: `Cache-Control: no-store`,
a JSON body, and an `application/json` content type (the `charset`, if present, must be `utf-8`). A `204` needs only
the `Cache-Control` header and an empty body.

## Running against the reference servers locally

### Python (`python/`)

```sh
cd python
EVEN_MAX_GROUP_BYTES=65536 EVEN_MAX_GROUP_EVENTS=200 EVEN_MAX_PAGE=50 \
EVEN_RATE_REQUESTS_PER_MINUTE=100000 EVEN_RATE_WRITES_PER_MINUTE=100000 \
EVEN_RATE_GROUP_CREATES_PER_MINUTE=100000 EVEN_DAILY_WRITE_BUDGET=0 \
  .venv/bin/even-server --db /tmp/even-conformance.db --port 8787

# in another shell
cd conformance && EVEN_SERVER_URL=http://127.0.0.1:8787 npx vitest run
```

### Cloudflare Worker (`worker/`)

The Worker reads the same `EVEN_*` names from `vars`, and `/v1/info` is built from the D1 `limits` table that is
seeded from them. The test values above, and matching rate-limiter thresholds, are already declared in the `test`
environment of `worker/wrangler.jsonc`, with its own local database. One script applies the schema, seeds the
limits from that environment and starts the dev server:

```sh
cd worker
npm run dev:test          # = db:schema:test && db:seed:test && wrangler dev --env test --port 8787

# in another shell
cd conformance && EVEN_SERVER_URL=http://127.0.0.1:8787 npx vitest run
```

See `worker/README.md` ("Running the conformance suite") for why this is an environment rather than `--var` flags.

### The blocked-group test

The suite authenticates as a fixed, public conformance secret and expects `410 group_blocked` on every group route.
It sends a valid token, so the result does not depend on whether a server checks the block before or after auth.

```sh
EVEN_SERVER_URL=http://127.0.0.1:8787 npm run --silent blocked-id     # prints the group id for this URL
# block that id on the server:
#   Python:  ../python/.venv/bin/even-server --db /tmp/even-conformance.db block <id>
#   Worker:  (cd ../worker && npx wrangler d1 execute even-test --local --env test --command \
#              "INSERT OR IGNORE INTO blocked (group_id, blocked_at) VALUES ('<id>', 0)")
EVEN_SERVER_URL=http://127.0.0.1:8787 EVEN_CONFORMANCE_BLOCKED_GROUP_ID=<id> npx vitest run
```

The id depends on the server URL (§2: group ids are per server), so compute it for the URL you test against.

### The rate-limit test

This test deliberately gets the machine running the suite rate-limited, so run it on its own, against an instance
with a small `EVEN_RATE_REQUESTS_PER_MINUTE` (for example 60) and the test caps:

```sh
EVEN_CONFORMANCE_RATE=1 EVEN_SERVER_URL=http://127.0.0.1:8787 npx vitest run src/rate.test.ts
```

It sends `GET /v1/info` in waves until it gets a `429`, up to three times the published `requests_per_minute`. It
then expects `rate_limited` and a `Retry-After` header.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `EVEN_SERVER_URL` | (required) | Server under test. `https://`, or `http://` on localhost / 127.0.0.1 only. |
| `EVEN_CONFORMANCE_BLOCKED_GROUP_ID` | unset | Enables the blocked-group test; must equal `npm run blocked-id`'s output. |
| `EVEN_CONFORMANCE_RATE` | unset | `1` enables the rate-limit test. |
| `EVEN_CONFORMANCE_TIMEOUT_MS` | `60000` | Per-test timeout. |
| `EVEN_CONFORMANCE_REQUEST_TIMEOUT_MS` | `20000` | Per-request timeout, so a stuck server fails a test instead of hanging the run. |

## Layout

| File | Contents |
|---|---|
| `src/keys.ts` | §2 derivation, §3 padding and sealing, §4 envelopes, and helpers that build deliberately malformed envelopes. |
| `src/client.ts` | Minimal typed HTTP client, plus the per-response §5 header check. |
| `src/env.ts` | `EVEN_SERVER_URL` parsing (and the http-only-on-loopback rule) and the opt-in switches. |
| `src/preflight.ts`, `src/global-setup.ts`, `src/setup.ts` | Preflight: `/v1/info` shape, test-limit gate, per-test header check. |
| `src/harness.ts` | `TestGroup` (a fresh group per test) and response assertions. |
| `src/keys.test.ts` | Known-answer tests for §2/§3, shared with the app's vectors (offline). |
| `src/info.test.ts` | §6.1 |
| `src/append-read.test.ts` | §6.2/§6.3: round trip, `seq`, `next`, `more`, `epoch`, `since`, `limit` clamping and errors, missing group. |
| `src/duplicates.test.ts` | §6.2 duplicates within and across requests. |
| `src/validation.test.ts` | §4/§6.2 every malformed envelope, whole-batch rejection with `index`, 400 before 415, batch bounds. |
| `src/auth.test.ts` | Malformed `groupId` → 400; missing, malformed or mismatched tokens → 401; no side effects. |
| `src/caps.test.ts` | `413 group_full` at the exact byte and event boundaries; duplicates exempt; nothing stored. |
| `src/concurrency.test.ts` | Atomic `seq` under 8 parallel appends; parallel retries stored once. |
| `src/delete.test.ts` | §6.4/§6.6 delete, idempotence, new epoch, `seq` restarting at 1. |
| `src/subscriptions.test.ts` | §6.5: 401 before 501. |
| `src/routes.test.ts` | 404, 405, and §5 headers on one response of each status. |
| `src/blocked.test.ts`, `src/rate.test.ts` | Opt-in, see above. |

## Readings of the protocol this suite pins

Where PROTOCOL.md leaves room, the suite takes one reading so that every server behaves the same. If one of these
is wrong, change PROTOCOL.md first, then the test.

- **400 before 415 across the whole batch (§6.2).** Every envelope is checked structurally, in array order, before
  any is checked for its version. A batch with an unknown `v` at index 0 and a structural error at index 2 gets
  `400 invalid_envelope` with `index: 2`.
- **`v` must be a positive integer (§4).** `0`, `-1`, `1.5`, `"1"`, `true` and `null` are `400 invalid_envelope`;
  only a positive integer the server does not support (`2`) is `415 unsupported_version`. This matches the app's
  `isEnvelope`/`envelopeShape`.
- **An id repeated within one request keeps its first occurrence**, and counts as 1 accepted + 1 duplicate. The
  second occurrence meets an id that already exists, and stored content is never replaced.
- **Non-object entries in `events`** (`null`, an array, a string) are `400 invalid_envelope` with their `index`, not
  `invalid_request`. The request shape (an `events` array of 1..`max_batch`) is checked first.
- **Ids follow the §4 rule literally.** An id is valid when it is exactly 22 characters from `[A-Za-z0-9_-]`, even if
  its last character carries non-zero trailing bits, as the app's decoder accepts.
- **A malformed `groupId` is `400`, even when a well-formed bearer token is present.** The path is validated before
  auth.
- **`/v1/info/` (with a trailing slash) is an unknown route**: `404`, not a redirect. The suite does not follow redirects.
- **`retention_days` must be published** (§9), as a non-negative integer.
