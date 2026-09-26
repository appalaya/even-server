# Even sync server: Python reference

A small, self-hostable Even sync server: FastAPI plus the standard library's
`sqlite3`. It implements [`PROTOCOL.md`](../PROTOCOL.md)
v1. It stores client-encrypted envelopes per group and hands them back in
order, and it cannot read any of them. Run it on a Raspberry Pi, a Mac mini, or
any small Linux box, with no Cloudflare account involved.

**Python 3.14 or newer is required.** Older interpreters are refused, by pip at
install time and by the server at start.

## Install

```bash
cd python
python3.14 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
pip install --no-deps -e .        # optional: provides the `even-server` command
```

`requirements.txt` pins `fastapi` and `uvicorn[standard]`. On 32-bit Raspberry
Pi OS, `uvicorn[standard]`'s optional speed-ups may have to compile. If that
fails, `pip install fastapi==0.141.1 uvicorn==0.54.0` works everywhere.

## Run

```bash
even-server                       # or: python -m even_server
```

It listens on `127.0.0.1:8787` and keeps its data in `./even.db`. The first
start creates the database. Check that it is running:

```bash
curl -s http://127.0.0.1:8787/v1/info
```

Clients refuse plain `http://`, so the next step is always HTTPS (below).

Commands:

| Command | What it does |
|---|---|
| `even-server` / `even-server serve` | Run the server. Flags `--host`, `--port`, `--db` override the environment. |
| `even-server block <groupId>` | Takedown: every request for that group id answers `410 group_blocked`, permanently. Add `--purge` to delete its stored events now; otherwise they are deleted by expiry. |
| `even-server unblock <groupId>` | Remove a block. |
| `even-server expire-now` | Delete idle groups now and exit, for cron users. The server also does this itself once at start and every 24 hours. `--expire-now` does the same. |

The operator commands work on the same database as a running server, so there
is no need to stop it. They never change the published limits: only the
server rewrites those, at start, from its own environment.

## Configuration

Everything is set through environment variables, read once at start. The limit
variables have the same names and defaults as the Cloudflare Worker. At start
they are written to the `limits` table, and `/v1/info` and every check read them
back from there, so what is published is what is enforced.

| Variable | Default | Meaning |
|---|---|---|
| `EVEN_MAX_EVENT_BYTES` | `8192` | Largest decoded ciphertext per envelope. |
| `EVEN_MAX_GROUP_BYTES` | `2097152` | Group cap: sum of (decoded ciphertext + 64) over its events. |
| `EVEN_MAX_GROUP_EVENTS` | `10000` | Group cap: number of events. |
| `EVEN_MAX_BATCH` | `25` | Envelopes per append request. |
| `EVEN_MAX_PAGE` | `500` | Envelopes per read page. |
| `EVEN_RETENTION_DAYS` | `365` | Groups with no write for this long are deleted. |
| `EVEN_RATE_REQUESTS_PER_MINUTE` | `120` | Per client IP, all requests. |
| `EVEN_RATE_WRITES_PER_MINUTE` | `60` | Per client IP, append requests. |
| `EVEN_RATE_GROUP_CREATES_PER_MINUTE` | `3` | Per client IP, first writes to new groups. |
| `EVEN_DAILY_WRITE_BUDGET` | `0` | Append requests per UTC day across the server; past it appends get `503` and reads continue. `0` means no budget. |
| `EVEN_TRUST_PROXY_HEADER` | unset | `X-Forwarded-For` or `CF-Connecting-IP`. **Read the warning below.** |
| `EVEN_OPERATOR` | unset | Your name, shown to users in group settings. |
| `EVEN_TERMS_URL` | unset | Link to your terms. |
| `EVEN_DB_PATH` | `./even.db` | SQLite database file. |
| `EVEN_HOST` | `127.0.0.1` | Listen address. Keep loopback when a proxy runs on the same machine. |
| `EVEN_PORT` | `8787` | Listen port. |

Rates are whole requests per minute over a sliding window, at least 1. IPv6
clients are keyed by their /64. Rate-limit state lives only in memory.

> **Proxy header warning.** Behind Caddy, nginx, a Cloudflare Tunnel, or any
> proxy, every request arrives from the proxy's address. Unless
> `EVEN_TRUST_PROXY_HEADER` names the header your proxy sets, **all your users
> share one rate-limit bucket** and will lock each other out. The reverse is
> also a risk: if you set it while clients can reach the server directly,
> they can forge the header and dodge the limits. So set it, and keep
> `EVEN_HOST=127.0.0.1` so that only the proxy can connect. For
> `X-Forwarded-For` the right-most address is used, which is the one your
> proxy added.

## HTTPS with Caddy

[Caddy](https://caddyserver.com) obtains and renews a certificate by itself.
Point a domain at the machine, open ports 80 and 443, and use
[`Caddyfile.example`](Caddyfile.example):

```caddyfile
sync.example.net {
	reverse_proxy 127.0.0.1:8787 {
		header_up X-Forwarded-For {remote_host}
	}
}
```

Then run the server with `EVEN_TRUST_PROXY_HEADER=X-Forwarded-For`.
Your server URL is `https://sync.example.net`.

> **Access-log warning.** Caddy writes no access log unless a `log` directive
> is present, so leave it out. A `log` directive records the full request URI
> of every request, and Even's URIs contain group ids, which the protocol says
> must not reach persistent logs. If you need an access log, use the redacted
> form in `Caddyfile.example` (it deletes `request>uri`, the `Authorization`
> header, and client addresses). Keep Caddy's global `debug` option off too.
> The same applies to nginx (`access_log off;` in the location block) and to
> anything else you put in front.

This server writes no access log of its own. uvicorn's access log is off, and
the server writes one JSON line per request to stderr:

```json
{"method":"POST","route":"/v1/groups/{groupId}/events","status":200,"ms":2.1,"limited":false}
```

That line holds the route *pattern*. It never holds the URL, the group id, the
token, the body, or the client's address. Unhandled errors are logged by
exception type and code location only.

## Without opening ports: tunnels

- **Cloudflare Tunnel** (`cloudflared`): route a hostname to
  `http://127.0.0.1:8787` and set `EVEN_TRUST_PROXY_HEADER=CF-Connecting-IP`.
  Cloudflare then sees your traffic, as it does for the public server; see
  `THREAT-MODEL.md`.
- **Tailscale Funnel**: `tailscale funnel 8787` publishes the server at
  `https://<machine>.<tailnet>.ts.net`. If your Funnel version does not pass
  the client address in `X-Forwarded-For`, leave `EVEN_TRUST_PROXY_HEADER`
  unset and raise the rate limits, since all clients will share one bucket.

## Docker

A `Dockerfile` (`python:3.14-slim`) and a `docker-compose.yml` are included.
They are **untested**, because no Docker was available where this was written.
The compose file stores the database in a named volume and publishes the port
on the host's loopback only, ready for Caddy on the host:

```bash
docker compose up -d --build
docker compose exec even even-server block <groupId>
```

## Data and backups

Every member's phone holds the group's full history, so this database is a
relay, not the source of truth. If it is lost or deleted, the next sync sees
a new epoch and the phones re-push everything. Backups are optional. The
database runs in WAL mode with `synchronous=FULL`, because a write that was
acknowledged and then lost in a power cut would otherwise never be re-sent.

## Tests

```bash
pip install -r requirements.txt -r requirements-dev.txt
python -m pytest -q
```

The tests use small caps and a temporary database. The concurrency test starts
a real uvicorn on a random port and has eight threads append into one group.

## Conformance suite

The suite in [`../conformance`](../conformance) defines what an Even server
is. It refuses to report success unless the server publishes small caps. Start
the server with test limits:

```bash
EVEN_DB_PATH=/tmp/even-conformance.db \
EVEN_MAX_GROUP_BYTES=65536 EVEN_MAX_GROUP_EVENTS=200 EVEN_MAX_PAGE=50 \
EVEN_RATE_REQUESTS_PER_MINUTE=100000 EVEN_RATE_WRITES_PER_MINUTE=100000 \
EVEN_RATE_GROUP_CREATES_PER_MINUTE=100000 \
even-server
```

and in another shell:

```bash
cd ../conformance && npm ci
EVEN_SERVER_URL=http://127.0.0.1:8787 npx vitest run
```

The rates are raised because the suite creates many groups from one address.
To include the blocklist test, get an id from `npm run blocked-id`, run
`even-server block <id>` against the same database, and pass it as
`EVEN_CONFORMANCE_BLOCKED_GROUP_ID`. Public servers should run the suite
against a staging instance with these limits, never against production.

## Layout

| File | Role |
|---|---|
| `even_server/app.py` | FastAPI app factory: routes, request prelude, error shapes, `Cache-Control`, request logging |
| `even_server/db.py`, `schema.sql` | SQLite store; caps and group accounting are triggers, as in `design.md` |
| `even_server/envelope.py`, `b64.py` | Append-body and envelope validation; strict unpadded base64url |
| `even_server/auth.py` | `base64url(sha256(token)) == groupId` |
| `even_server/ratelimit.py` | Sliding-window per-IP limits, IPv6 /64 keying, proxy header |
| `even_server/limits.py`, `config.py` | Published limits and `/v1/info`; `EVEN_*` parsing |
| `even_server/expiry.py` | Idle-group expiry thread and `expire-now` |
| `even_server/main.py` | Command line |
