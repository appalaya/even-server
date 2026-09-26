# Even Sync Server

*The dumb half of Even.*

Even is a free, ad-free, account-free app for splitting expenses with friends.
This repository is the sync server: a small, stateless-by-design blob store
that moves client-encrypted events between phones. It never sees an expense.

- **Protocol:** [`PROTOCOL.md`](PROTOCOL.md) — the complete contract. Anyone can implement it.
- **Threat model:** [`THREAT-MODEL.md`](THREAT-MODEL.md) — what the server can and cannot know.
- **Reference servers:** `worker/` (Cloudflare Workers + D1, what runs at sync.even.appalaya.com) and `python/` (a small FastAPI + SQLite package, for self-hosters).
- **Conformance suite:** `conformance/` — run it against any URL; passing it is what makes a server an Even server.

## Why a server at all

Two phones need a place to exchange data when neither is online at the same
time. That is the entire job. The app works fully offline, every phone holds
the full history, and the server can vanish without anyone losing anything.

## Why you can host your own

Because the app's promise is "free forever, even if the authors disappear."
A group's invite carries the server URL, so any group can point at any server.
The reference servers are a few hundred lines each and the protocol fits on a
few pages.

## Self-hosting in short

```bash
# Python reference: Python 3.14 or newer
cd python
python3.14 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt && pip install --no-deps -e .
EVEN_RETENTION_DAYS=365 even-server               # or: python -m even_server; listens on 127.0.0.1:8787
```

Put it behind HTTPS (Caddy gets a certificate for you; a Cloudflare Tunnel or
Tailscale Funnel works from a home network). Clients refuse plain HTTP. If a
proxy sits in front, set `EVEN_TRUST_PROXY_HEADER` so rate limits see real
client addresses, and turn off the proxy's access log or it will record group
ids. Then create a group in the app and put your server URL in the "sync
server" field, or move an existing group there from its settings. Full
instructions live in `python/README.md` and `worker/README.md`.

## Project structure

```
PROTOCOL.md            — the contract
THREAT-MODEL.md        — security and privacy posture
scope.md               — what's in and out for v1
design.md              — architecture of the reference servers
working-principles.md  — how we work
worker/                — Cloudflare Workers + D1 reference (TypeScript)
python/                — FastAPI + SQLite reference
conformance/           — protocol test suite
```

## License

MIT. See `LICENSE`.
