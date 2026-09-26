# How We Build

We follow a sequence. When we notice we're jumping ahead, we pause and ask: intentional or drift?

## The Sequence

### 1. Think — What are we solving and why?
- Frame the problem before designing solutions
- Ask: what would we need to know to solve this well? Name what's missing before filling gaps
- If I don't have enough context, I ask — I don't fill gaps with assumptions
- Meta-prompt complex tasks: "Write me a prompt for this" → review it → strip biases → execute
- When the user says "that's wrong" and the first correction didn't change my output: stop defending, write the test for my own claim, execute it

### 2. Design — How should we approach it?
- The approach should follow from the framing, not precede it
- Plan mode when the risk is scope ("are we building the right thing?"), meta-prompt when the risk is framing ("are we building it the right way?")
- Prewash the design: strip adjectives, replace vague with measurable, search for what's literally needed
- When evaluating options: focus on where perspectives diverge, not where they agree. Divergence is where the real decision lives

### 3. Build — Implement the design
- Stay on the current task. Stray thoughts go to the parking lot
- When the user gives a vague instruction ("make it better"), state back the concrete interpretation before acting
- Enforce critical constraints structurally (validation, forbidden patterns), not just through instructions

### 4. Review — Does what we built match what we designed?
- Two quality checks: code quality and output quality. "It works" and "it's good" are separate questions
- Run real inputs through the pipeline and read the actual output — not just logs and status codes
- Audit for completeness: placeholder code, TODO comments, unimplemented sections = not done
- Complexity of the task determines verification depth

### 5. Ship — Declare done only when reviewed
- Name what was deferred, descoped, or left unfinished — with reasons
- Review the parking lot: what stray thoughts deserve attention now?

## Always Active

**Acknowledgment ≠ integration.** When corrected, verify the correction changes the conclusion, not just the conversation.

**The human's contribution is the thinking.** The human detects when something is off. The method (/challenge) executes the examination. Don't automate the human's instinct — support it.

**When in doubt, ask.** Don't fill gaps with projections. An assumption I don't name is a bias I can't catch.

## Parking Lot

When the user says "parking lot:" followed by a thought — note it, don't act on it. Return to it after the current task is reviewed and shipped.

## Project Context

**Even Sync Server** — the server half of Even, a free, ad-free, account-free expense-splitting app.

- **Type**: Web service (tiny). Cloudflare Workers + D1 reference in TypeScript; FastAPI + SQLite reference in Python; a conformance test suite.
- **Purpose**: Move client-encrypted event envelopes between the phones in a group, in arrival order, without being able to read them, in a way anyone can self-host.
- **Contract**: `PROTOCOL.md` is the source of truth. Code follows the document, never the other way round. A change that needs the document to change is a protocol change and gets discussed first.
- **Privacy invariant**: the server must have no code path that can receive or derive the encryption key, and must never log request bodies, tokens, or request URLs (they contain group ids). Workers invocation logs stay off; uvicorn runs without its access log. Re-read `THREAT-MODEL.md` before touching auth, storage, or logging.
- **Non-goals that look like gaps**: no users, no sessions, no content validation, no realtime, no admin UI, no client attestation. These are decisions, not omissions. See `scope.md`.
- **Companion repo**: `../even-app` (Expo client). The event *contents* schema lives there, because the server never sees it.
- **Public deployment**: `https://sync.even.appalaya.com` (Worker). Landing page and universal links at `https://even.appalaya.com` are the app repo's concern.

### Working rules specific to this repo

- Every limit is configuration (`wrangler.jsonc` vars or `EVEN_*` env vars, same names) and is published in `/v1/info`, rate limits included. Adding an unpublished limit is a bug.
- Caps and counters live in SQLite triggers, not application code, so batches are atomic on D1.
- The conformance suite is the definition of correctness. A server change without a corresponding test is not done.
- Prefer zero dependencies in the Worker. A router is not worth a dependency.
- Both references read the same `EVEN_*` variable names.

## References

- `PROTOCOL.md` — the contract
- `THREAT-MODEL.md` — what the server can and cannot know
- `working-principles.md` — detailed principles with triggers, actions, and anti-patterns
- `scope.md` — what's in and out for this project
- `design.md` — architecture of the reference servers and the conformance suite
