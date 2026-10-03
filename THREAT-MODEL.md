# Threat Model — Even

What the sync server can know, what it cannot, who we defend against, and what
we deliberately do not defend against. This is the document behind the claim
"we cannot read your data." If the claim ever stops being literally true, this
document changes first.

## Assets

1. **Expense content.** Amounts, titles, notes, categories, dates, who paid, how
   it was split, who settled with whom.
2. **Group composition.** Member names and how many there are.
3. **Group identity.** The group's name.
4. **Membership itself.** That a given device belongs to a given group.
5. **The invite.** Possession equals full read/write access to the group.

## Actors

| Actor | Capability |
|---|---|
| **Sync server operator** | Reads the database and logs, sees every request, and sets the arrival time members order edits by. Includes us running the free server, and any self-hoster. |
| **Hosting platform** | Cloudflare terminates TLS for the public server and the landing page. It can see tokens, IPs, and URLs in flight, and keeps its own access logs under its own retention. |
| **Landing page operator** | Serves the JavaScript that reads the invite fragment at `even.appalaya.com/i`. Same party as the public server operator. A trusted component. |
| **Contact page bot check** | Cloudflare Turnstile, on `even.appalaya.com/contact`. Its script runs in the page with the page's own access, and its challenge frame sees the IP and browser details. A trusted component. The page adds the script only once no invite can be on it: a pasted invite is cleared from its field the moment it is read, and the field stays closed from then on. |
| **Other servers the group has used** | Any operator whose server a group synced through at some point. |
| **Backup provider** | Apple and Google, holding the device backup that includes the app's local database and keychain items. |
| **Network observer** | Sees TLS metadata: server hostname, timing, sizes. Cannot see inside TLS. |
| **Link finder** | Someone who obtains an invite: a forwarded chat, a screenshot, browser history, a lost phone with the chat app unlocked. |
| **Hostile member** | A legitimate holder of the invite running a modified client. |
| **Device thief** | Physical possession of an unlocked phone. |

## What the server sees

For each group: the per-server group id (a hash), the epoch, the number of
events, the **size class** of each ciphertext (plaintext is padded to 256-byte
buckets, so the server sees a bucket, not an exact length), the arrival time of
each event, and the IP address of each request.

For each request: which group id, whether it was a read or a write, and the
bearer token, which yields only the group id and is different for every server.

From these, an operator can infer: roughly how active a group is and when;
that requests from one IP over time probably come from one device, and hence
which events were probably authored by the same device; from size classes, a
coarse distinction between very small events (deletes, renames) and larger
ones (expenses in big groups); how many devices a group has, because after an
epoch change each device re-pushes the whole log from its own IP; and that a
new group is probably the rotated successor of an old one, because a full log
of matching size classes arrives from the same IP shortly before a single
final write to the old group. That is the complete list.

Envelope ids are random, so they carry no timestamp. The nonce is random. The
ciphertext is XChaCha20-Poly1305 under a key the server has no code path to
receive.

## What the server cannot see

Anything in asset classes 1 through 3. Not the amount, not the currency, not
the group name, not a single member name, not which named member added which
event. It cannot tell whether two events concern the same expense. It cannot
read, forge, or relabel an event. It does choose the arrival time it reports
for each event, and clients take that time as the latest an event can claim.
With it, the operator can decide which of two existing writes to the same field
wins, and show different members different winners. That is the power it
already has by withholding events, and it is healed the same way, by moving the
group. It cannot make a write count as later than its author stamped it.

A server operator with full database and log access, and full knowledge of the
protocol and source code, learns exactly the metadata in the previous section
and nothing else. This is the property the conformance suite and the code
review protect.

## Defended threats

| Threat | Defence |
|---|---|
| Operator reads expenses | Client-side encryption. Key derived from the secret via HKDF and never transmitted. Plaintext padded to hide exact lengths. |
| Operator or network observer replays an event into another group, under another id, or as another envelope version | Protocol version, group id, envelope version, and event id are bound into the AEAD associated data; decryption fails. |
| Operator truncates or loses the log | Clients keep full local copies and merge by event id. If the server's copy is lost or replaced, the epoch changes and every client re-pushes its full log. Nothing is corrupted. |
| Operator selectively withholds events from one member | Not detected: acknowledged events are not pushed again while the epoch is stable. The remedy is moving the group to another server, which replays everything. |
| An operator the group once used attacks the group on another server | Auth tokens are derived per server origin. A token for one server is useless at any other. |
| Group id guessed | Group id is a hash of 256 random bits. Enumeration yields nothing without the token. |
| Token brute force | 256-bit token. Infeasible. |
| Server fills with junk | Per-event, per-group (bytes and count), per-batch caps; per-IP request, write, and creation limits; a global daily write budget; idle-group expiry. See "Abuse posture." |
| A member's device pushes malformed events to crash others | Every decrypted event is schema-validated on the client; invalid ones are skipped and counted, never fatal. Junk that fails authentication is bounded and purgeable. |
| A member, or a phone with a wrong clock, stamps an event years ahead so it wins every later edit | Each event counts at the earlier of its stamp and the server's arrival time. An event stamped more than a day past the group's latest arrival is held back until real time catches up, on every server it is copied to. Arrival times come from the server, so no member can forge them, from any number of device ids. |
| Invite leaks | Rotate: new secret, new keys, re-encrypted log under a new group, and a "closed" marker written into the old group so stragglers stop and ask for the new invite. The leaked invite continues to open the old, closed copy; it never sees anything written to the new group. When a straggler moves to the new group it carries over only events its own device wrote, so nothing the leak-holder wrote after the rotation can reach the new group. Closed groups are never self-healed, so once the old copy expires it stays gone. |
| Mistyped invite code | Checksum in the invite; a corrupted code is rejected rather than silently joining an empty group. |
| Server disappears | Every device holds the full log. Any member issues a new invite naming a new server; members who accept it move over and re-push. The group file export needs no server at all. |
| Downgrade to plaintext HTTP | Client refuses non-HTTPS server URLs and refuses invalid certificates. Not configurable in a release build; a development build may use plain HTTP only to a server on the same machine or its private network (PROTOCOL.md §5). |
| Landing page exfiltrates the fragment | The page is served with a strict Content Security Policy (no external scripts, no connections), no third-party or platform-injected scripts, and inserts the group name as text only. The page never sends the fragment anywhere. An in-app browser's own scripts are outside this; see "Not defended." |
| Plaintext reaches backups | The app writes these to disk in plaintext: each event's ordering timestamp; the group's name and currency (both also plaintext in the invite); the user's own member name and emoji (the `prefs` rows `me.name` and `me.emoji`, filled in when the user creates or joins a group; asset class 2); bookkeeping such as each group's server URL and the user's member id; and, while a server-copy delete is outstanding, that server's bearer token (which yields only a group id). That token's time on disk is bounded: the app gives the debt up at its 20th failed attempt or 30 days after it was recorded, whichever comes first, and the token then leaves the disk and its backups, so a server gone for good does not keep it there forever; the copy itself is not deleted and stays until the server's own expiry removes it (even-app `design.md`, "Pending deletes"). The app writes no other decrypted content. Backups contain ciphertext, those things, and, on iOS, the group secrets in the keychain. |
| Junk resurrects after takedown | An operator takedown is a blocklist entry answered with `410`, which clients treat as terminal and never self-heal. A plain delete would be undone by the next member who syncs. |

## Not defended, on purpose

- **A hostile member.** Anyone with the invite can read everything, write
  anything, claim any member name, and forge the device id inside their
  events. This is identical to the trust model of a shared spreadsheet or a
  Splitwise group. Attribution is by claim, not by signature. The device id in
  events detects accidental double-claims, not deliberate impersonation.
  Per-device signing keys are a possible later addition; the event schema
  already carries a device id so it would be additive.
- **Traffic analysis by the operator or platform.** Size classes, timing, and
  IPs reveal that a group exists, roughly how active it is, from where, and
  which events likely share an author. Padding and mixing beyond 256-byte
  buckets are out of scope.
- **A wrong server clock.** More than a day behind holds back every write; far
  ahead lets far stamps through. Moving the group restores both.
- **Arrival times are shared.** Every member sees when each event reached the
  server, and so when each device was online.
- **The hosting platform.** Cloudflare sees what the operator sees plus tokens
  in flight, and keeps its own logs. A user who does not accept this can
  self-host on a machine they control.
- **A backup that contains the key.** On iOS the keychain is backed up, so an
  iCloud backup contains everything needed to read the group. On Android the
  keystore-wrapped secrets are not restorable, so an Android backup cannot
  open a group: it holds ciphertext and the plaintext listed under "Plaintext
  reaches backups", the user's own name and emoji included. This is stated on
  the privacy page. Users who need otherwise can turn off device backup or
  enable end-to-end-encrypted backup at the OS level.
- **Lock-screen previews.** Background refresh hands decrypted activity text
  ("Maya added Dinner · 90.00") to the OS as a local notification, which the
  OS stores and may show on the lock screen. Users control that with the OS
  notification settings; the app's toggle turns the notifications off
  entirely.
- **The app-switcher snapshot.** The OS keeps an image of the app's last
  screen to show in its app switcher, and that image can show amounts and
  names.
- **Browser history.** Opening an invite link in a browser stores the full
  URL, fragment included, in history, which may sync to the browser vendor.
  The app leads with the link: the group's share menu offers "Share link" and
  "Show QR code" (the QR encodes the link), and "Share link" is the primary
  button on both invite cards. The code avoids browser history for those who
  prefer it: "Copy code" sits beside "Share link" on the group screen's invite
  card (shown until another member joins) and in Group settings under Invite.
- **In-app browsers.** Chat and social apps often open links in their own
  in-app browser, a WebView that can inject the app's own scripts into any
  page. Those scripts are not bound by the page's CSP and can read the `/i`
  fragment, and with it the invite.
- **Forward secrecy.** One key per group for the group's lifetime. A leaked
  secret reads the whole history. Rotation limits the future, not the past.
- **Deniability.** None claimed.
- **An unlocked phone.** The app has no lock of its own in v1. Group secrets
  live in the OS keychain, readable after first unlock so background refresh
  can run.
- **Compromised client build.** Open source lets anyone audit the code; it does
  not prove the store binary matches. Reproducible builds are not attempted.

## The invite is the key

This is the property users must understand, and the app says it in one
sentence on the group screen: *anyone with this link can see and edit the
group, and if you lose it and your phone, the group is gone.* There is no
account to recover from, because there is no account.

Consequences the design accepts:

- Sharing an invite in a group chat is the intended path and is as safe as that
  chat.
- Deleting the app deletes the local log. On iOS the keychain entries survive
  reinstall and the app keeps an index of them, so a reinstall can recover a
  group's secret and re-pull its log from the server; on Android they do not.
  Otherwise, recovery is a re-shared invite, an iOS backup, or the group file.
- The group file export contains the secret alongside the ciphertext. It is
  exactly as sensitive as the invite and is labelled that way.
- The landing page host never receives the secret: it is in the URL fragment.
  The page's own script reads it, which is why that script is constrained as
  above.
- The contact page reads a pasted invite only to work out the group id for a
  report. It clears the field at once, sends only the id and server, and
  loads Cloudflare Turnstile only after that.

## The client's crypto code

Once a startup self-test passes, the iOS and Android clients seal and open with XChaCha20-Poly1305 through a
native module.

- On iOS this is libsodium 1.0.22: prebuilt static libraries committed in swift-sodium 0.11.0's repository. Swift
  Package Manager fetches them from GitHub at build time, at the commit pinned in Package.resolved. There is no
  separate checksum; the app's CI hashes the library it resolved against known values.
- On Android it is Google Tink 1.23.0 from Maven Central, pinned strictly and checksum-verified by Gradle, using
  Tink's internal InsecureNonceXChaCha20Poly1305 class.
- @noble/ciphers remains the reference. It is used on the web, in tests, and for the whole process whenever the
  module is missing or fails the self-test, and any envelope the native code rejects is re-checked with @noble,
  which decides; a disagreement switches the process to @noble.

The wire format, AAD, padding, nonce generation (24 random bytes from the platform CSPRNG via
crypto.getRandomValues, drawn in JavaScript) and key derivation (HKDF in JavaScript) are unchanged. Nothing new
reaches the server or the disk.

For the length of one call, the native code receives the encryption key, the nonce, the AAD (which contains the
group id) and the padded plaintext or ciphertext. A call is one envelope, or up to 200 envelopes of one group in a
batched open.

- On iOS, libsodium reads and writes the JavaScript-owned buffers directly, without copying them. It wipes its own
  derived secrets (the HChaCha20 subkey, the ChaCha20 state, and the Poly1305 key and state) before returning, and
  leaves zeros after a failed open.
- On Android, the key, nonce, AAD and data are copied into Java arrays. The module wipes its own copies after
  use; Tink keeps further Java-array copies of the key and derived subkeys, and each result passes through one
  transient native-heap buffer on its way back to JavaScript. Those are not wiped; they stay in memory until it is
  reused.

On neither platform does the native code keep a reference to any argument after the call, log anything, or use
the network. JavaScript logs one fixed line naming the implementation. As before, JavaScript's own copies of keys
and plaintext are not wiped either.

This adds third-party native crypto to the client's trusted code: a prebuilt libsodium binary on iOS, and Tink
with its small transitive dependencies on Android. Before the first store open, the self-test checks the native
code against a published test vector, forged tags, ciphertext, AAD and nonces, a wrong key, empty inputs, offset
views, sizes from 63 bytes to the 8,176-byte maximum, a 64-item batch containing forgeries, and random cases
cross-checked with @noble.

## Abuse posture

The free server is, by construction, an anonymous encrypted blob store. It can
therefore be misused to store or relay content we cannot see. We do not try to
inspect content, because we cannot without breaking the core promise. We make
the store a poor one instead:

- Event cap 8 KB, group cap 2 MB and 10,000 events, idle expiry after 12 months.
- Per IP: requests per minute, a lower write-requests-per-minute limit, and
  group creations per minute. IPv6 keyed by /64.
- Per IP, an allowance for event reads counted by size, in units of 100
  database rows: a poll with nothing new costs 1, a full page of 500 events
  costs 6, and the public server allows 120 a minute. That is at most 17
  million rows a day from one address, a fraction of a percent of the paid
  plan's monthly allowance, so one client's event reads cannot spend the
  quota and stop everyone's reads. It does not hold many addresses, or one address using
  every other route at its limit too; those need a rate rule in front of the
  server or a paid plan.
- A global daily write budget on the public server, counted in events stored
  rather than requests: an envelope the group already holds costs nothing, so
  devices re-pushing a log after an epoch change pay for it once. Past it,
  writes return 503 and reads continue. A quiet day for us, not a bill.
- No push, no realtime, no delivery guarantees: a bad messenger.
- A published abuse contact and a one-statement takedown: add a group id to
  the blocklist. Expiry and plain deletion are undone by any active member;
  the blocklist is not.
- No client attestation. It would be theatre against an open protocol and
  would break self-hosting.

This is the standard "conduit" position taken by end-to-end-encrypted services.

## What we log

Counters needed for limits, keyed by IP, expiring within an hour. One log
line per request with method, route *pattern*, status, and duration. Never
request bodies, never tokens, never full URLs (they contain group ids), never
IPs. On Cloudflare
this means Workers invocation logging is disabled; the Python reference runs
with the access log off and its README warns that a reverse proxy in front
logs full URIs unless told not to. That includes errors: Caddy, in the Python
reference's example setup, writes the request URI and the client's address to
its error log whenever it fails a request itself (a 502 while the server
restarts), with or without an access log, unless the site answers errors with
`handle_errors`, as `Caddyfile.example` does.

## Review checklist

Any change to the server or the client's crypto module must re-answer:

1. Can the server, with this change, learn anything new about assets 1–3?
2. Does any new field leave the ciphertext? If so, why, and is it random?
3. Does any new endpoint accept something other than the bearer token as
   identity?
4. Is there a new way for one member to break another member's client?
5. Did a limit become unenforced or unpublished?
6. Did anything decrypted start touching disk?
7. Does the client trust anything the server reports beyond the ciphertext
   (`seq`, `epoch`, `received_at`)? What does a hostile server gain from it,
   beyond what withholding already gives it?
