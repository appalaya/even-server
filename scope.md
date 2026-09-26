# Scope — Even Sync Server v1

## Purpose

Move client-encrypted event envelopes between the phones in a group, in order,
without ever being able to read them, in a way that anyone can host.

## V1 — In Scope

1. **The protocol document** (`PROTOCOL.md`) as the primary deliverable. The
   servers exist to prove the document is implementable.
2. **Cloudflare Workers + D1 reference** — what runs the free public server.
   Zero-ops, free tier, deployed once.
3. **Python + SQLite reference** — one file plus a Dockerfile, for people who
   want to run it on a Raspberry Pi or a Mac mini.
4. **Conformance suite** — executable, runs against any base URL, covers every
   MUST in the protocol including concurrent-write sequencing.
5. **Operator limits as configuration** — event size, group bytes, group
   event count, batch size, page size, retention, per-IP request, write and
   creation rates, and a global daily write budget. All published via
   `/v1/info`.
6. **Idle-group expiry** — scheduled deletion of groups with no writes for the
   retention period.
7. **Abuse basics** — per-IP rate limits, a daily write budget that turns the
   public server read-only rather than producing a bill, takedown by group
   id, a terms page and abuse contact for the public server.
8. **Epochs** — a random value per group incarnation so clients notice a
   deleted or expired copy and rebuild it.

## V1 — Out of Scope

- **Push notifications.** The endpoint is reserved in the protocol and returns
  `501`. Implementing it means storing device tokens; that is a threat-model
  change and a separate decision.
- **Accounts, users, permissions.** There are none. The bearer token is the
  whole identity model, by design.
- **Server-side validation of event contents.** Impossible without the key,
  and the point is that the server does not have the key.
- **Realtime transport** (WebSockets, SSE). Polling on foreground plus
  background refresh is enough for an expense app, and realtime would make the
  server a better covert messenger.
- **Multi-region, replication, high availability.** Every phone holds the
  full log. Server downtime is an inconvenience, not a loss.
- **Admin UI.** Operators use SQL and environment variables.
- **Metrics beyond counters.** No request bodies, no per-group analytics.
- **Attestation or client fingerprinting.** Any protocol-conformant client is
  a valid client. See `THREAT-MODEL.md`.

## Design Constraints

- The server must have no code path that could receive or derive the
  encryption key.
- Every limit must be operator-configurable and published.
- A server implementation in any language must be able to pass the
  conformance suite from the protocol document alone.
- The public server must run within Cloudflare's free tier for a friend-group
  scale of users, and cost at most the five-dollar paid tier well beyond that.

## Key Decisions

| Decision | Rationale |
|---|---|
| Group id = hash(auth token), no registration | Stateless membership check, no password table, nothing to sign up for. |
| Implicit group creation on first write | One fewer endpoint; a missing group and an empty group are indistinguishable. |
| Whole-batch rejection on any invalid envelope | Simpler client contract; partial acceptance would need per-envelope results and a client that reasons about them. |
| Server-assigned `seq` as the only cursor, scoped by epoch | Arrival order is the only order a blind server can provide. Time lives inside the ciphertext. The epoch makes a recreated group detectable. |
| `DELETE` allowed to any token holder | Everyone has a local copy and self-heals, so deletion is a cache purge. Rotation does not use it; it closes the old group instead. |
| Auth token derived per server origin | A token is useless anywhere but the server it was derived for. |
| Caps enforced by SQLite triggers | D1 has no interactive transactions; putting the cap and the counters in triggers makes a batch atomic without one. |
| Rates expressed per minute | The Workers rate-limiting binding supports 10- and 60-second windows only. |
| Public server publishes `max_batch = 25` | A 100 × 8 KB batch can exceed the free-plan CPU budget per request. |
| Caps and expiry instead of content inspection | The only honest abuse defence for an encrypted store. |
| Python reference in addition to the Worker | Proves the protocol is boring enough to port, and serves people who will never touch Cloudflare. |
| Push reserved as `501` | Keeps adding push additive rather than a protocol bump, without taking on device tokens now. |
