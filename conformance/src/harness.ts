/**
 * Shared test harness: the preflight result, a fresh-group helper, and assertions for protocol responses.
 * Every test builds its own TestGroup from a new random secret, so tests are independent, can run in parallel,
 * and never assume a clean database.
 */
import { expect, inject } from 'vitest';
import { EvenClient, type AppendOk, type ErrorBody, type Info, type Limits, type ReadOk, type ReadQuery, type Reply, type StoredEnvelope } from './client.ts';
import { options, type ServerTarget } from './env.ts';
import { deriveLocal, deriveServer, fromUtf8, isB64url, MIN_C_BYTES, newSecret, open, seal, type Envelope, type SealOptions } from './keys.ts';

const NOT_PREFLIGHTED =
  'The preflight did not run, so the server under test is unknown. Run the suite from conformance/ with its ' +
  'vitest.config.ts: EVEN_SERVER_URL=http://127.0.0.1:8787 npx vitest run';

export function target(): ServerTarget {
  const value = inject('target');
  if (value === undefined) throw new Error(NOT_PREFLIGHTED);
  return value;
}

export function info(): Info {
  const value = inject('info');
  if (value === undefined) throw new Error(NOT_PREFLIGHTED);
  return value;
}

export function limits(): Limits {
  return info().limits;
}

let sharedClient: EvenClient | undefined;

export function client(): EvenClient {
  sharedClient ??= new EvenClient(target().base, options.requestTimeoutMs());
  return sharedClient;
}

// ---------- groups ----------

let bodyCounter = 0;

export class TestGroup {
  readonly secret: Uint8Array;
  readonly key: Uint8Array;
  readonly token: string;
  readonly groupId: string;

  private constructor(secret: Uint8Array) {
    this.secret = secret;
    this.key = deriveLocal(secret).encryptionKey;
    const server = deriveServer(secret, target().origin);
    this.token = server.token;
    this.groupId = server.groupId;
  }

  /** A group nobody has used: a new random 32-byte secret, derived for this server's origin (§2). */
  static fresh(): TestGroup {
    return new TestGroup(newSecret());
  }

  static fromSecret(secret: Uint8Array): TestGroup {
    return new TestGroup(secret);
  }

  /**
   * A real envelope sealed for this group. By default a conforming v1 envelope (small JSON body, 256-byte ciphertext);
   * `cipherBytes` gives an exact decoded `c` length instead (empty body, 7816-4 padded to fit).
   */
  envelope(overrides: Omit<SealOptions, 'key' | 'groupId'> = {}): Envelope {
    const plaintext = overrides.plaintext ?? (overrides.cipherBytes === undefined ? JSON.stringify({ conformance: true, i: ++bodyCounter }) : '');
    return seal({ ...overrides, key: this.key, groupId: this.groupId, plaintext });
  }

  envelopes(count: number, overrides: Omit<SealOptions, 'key' | 'groupId' | 'id'> = {}): Envelope[] {
    return Array.from({ length: count }, () => this.envelope(overrides));
  }

  /** The smallest structurally valid envelope (§4): a real 17-byte ciphertext, stored size 81. */
  tiny(): Envelope {
    return this.envelope({ cipherBytes: MIN_C_BYTES });
  }

  /** Decrypts an envelope read back from the server and returns its body text. */
  opened(envelope: Envelope): string {
    return fromUtf8(open({ key: this.key, groupId: this.groupId, envelope }));
  }

  append(events: readonly unknown[]): Promise<Reply> {
    return client().append(this.groupId, this.token, events);
  }

  async appendOk(events: readonly unknown[]): Promise<AppendOk> {
    return expectAppendOk(await this.append(events), events.length);
  }

  /** Appends in chunks of max_batch; every chunk must be a 200. Returns the last acknowledgement. */
  async appendAll(events: readonly Envelope[]): Promise<AppendOk> {
    const { max_batch } = limits();
    let last: AppendOk | undefined;
    for (let i = 0; i < events.length; i += max_batch) last = await this.appendOk(events.slice(i, i + max_batch));
    if (last === undefined) throw new Error('appendAll needs at least one envelope');
    return last;
  }

  read(query: ReadQuery = {}): Promise<Reply> {
    return client().read(this.groupId, this.token, query);
  }

  async readOk(query: ReadQuery = {}): Promise<ReadOk> {
    return expectReadOk(await this.read(query));
  }

  /** Reads every event by looping on `more` (§6.3), checking that the epoch holds still across pages. */
  async readAll(): Promise<ReadOk> {
    const events: StoredEnvelope[] = [];
    let page = await this.readOk();
    events.push(...page.events);
    const epoch = page.epoch;
    for (let guard = 0; page.more; guard++) {
      if (guard > 10_000) throw new Error('readAll: `more` never became false');
      page = await this.readOk({ since: page.next });
      expect(page.epoch, 'epoch changed between pages').toBe(epoch);
      events.push(...page.events);
    }
    return { events, next: page.next, more: false, epoch };
  }

  delete(): Promise<Reply> {
    return client().deleteGroup(this.groupId, this.token);
  }

  subscribe(body: unknown = {}): Promise<Reply> {
    return client().subscribe(this.groupId, this.token, body);
  }
}

// ---------- assertions ----------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSeq(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** One line describing a reply, used as the failure message of every status assertion. */
export function show(reply: Reply): string {
  return `${reply.method} ${reply.path} → ${reply.status} ${reply.text.slice(0, 500)}`;
}

export function expectStatus(reply: Reply, status: number): void {
  expect(reply.status, show(reply)).toBe(status);
}

/** §7: the status, a JSON object body with the given `error`, an optional string `message`, and `index` when asked. */
export function expectError(reply: Reply, status: number, error: string, extra: { index?: number } = {}): ErrorBody {
  expectStatus(reply, status);
  expect(isRecord(reply.json), `error bodies are JSON objects (§7): ${show(reply)}`).toBe(true);
  const body = reply.json as ErrorBody;
  expect(body.error, show(reply)).toBe(error);
  if (body.message !== undefined) expect(typeof body.message, `"message" must be a string: ${show(reply)}`).toBe('string');
  if (extra.index !== undefined) expect(body.index, `"index" of the first offender: ${show(reply)}`).toBe(extra.index);
  return body;
}

/** A 22-character base64url epoch (16 random bytes, §6.6). */
export function expectEpoch(epoch: unknown, context: string): asserts epoch is string {
  expect(typeof epoch === 'string' && isB64url(epoch, 22), `epoch must be 22 base64url characters (§6.6), got ${JSON.stringify(epoch)}: ${context}`).toBe(true);
}

/** A `received_at` value (§4): Unix milliseconds, a safe integer. How close it is to now is checked where it is known. */
export function isArrival(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/**
 * §6.2 response: 200 with integer accepted, duplicates and seq, an epoch, and a `received_at` array of safe integers.
 * `sent` checks accepted + duplicates and that `received_at` has one value per envelope sent.
 */
export function expectAppendOk(reply: Reply, sent?: number): AppendOk {
  expectStatus(reply, 200);
  expect(isRecord(reply.json), show(reply)).toBe(true);
  const body = reply.json as AppendOk;
  for (const field of ['accepted', 'duplicates', 'seq'] as const) {
    expect(isSeq(body[field]), `"${field}" must be a non-negative integer: ${show(reply)}`).toBe(true);
  }
  expectEpoch(body.epoch, show(reply));
  expect(
    Array.isArray(body.received_at) && body.received_at.every(isArrival),
    `"received_at" must be an array of Unix-millisecond safe integers (§6.2): ${show(reply)}`,
  ).toBe(true);
  if (sent !== undefined) {
    expect(body.accepted + body.duplicates, `accepted + duplicates must equal the envelopes sent: ${show(reply)}`).toBe(sent);
    expect(body.received_at.length, `"received_at" must hold one value per envelope sent (§6.2): ${show(reply)}`).toBe(sent);
  }
  return body;
}

/**
 * §6.3 response: 200, events ascending by seq with {seq, id, v, n, c, received_at}, integer next, boolean more, epoch
 * or null. `received_at` never decreases along seq: equal within a request, greater for every later request (§4).
 */
export function expectReadOk(reply: Reply): ReadOk {
  expectStatus(reply, 200);
  expect(isRecord(reply.json), show(reply)).toBe(true);
  const body = reply.json as ReadOk;
  expect(Array.isArray(body.events), `"events" must be an array: ${show(reply)}`).toBe(true);
  let previous = 0;
  let previousArrival = 0;
  for (const event of body.events) {
    const where = `event ${JSON.stringify(event).slice(0, 120)} in ${show(reply)}`;
    expect(isRecord(event), where).toBe(true);
    expect(isSeq(event.seq) && event.seq >= 1, `seq must be an integer ≥ 1: ${where}`).toBe(true);
    expect(event.seq > previous, `events must be in ascending seq order: ${where}`).toBe(true);
    previous = event.seq;
    expect(typeof event.id === 'string' && isB64url(event.id, 22), `id: ${where}`).toBe(true);
    expect(typeof event.v === 'number' && Number.isSafeInteger(event.v), `v: ${where}`).toBe(true);
    expect(typeof event.n === 'string' && isB64url(event.n, 32), `n: ${where}`).toBe(true);
    expect(typeof event.c === 'string' && isB64url(event.c), `c: ${where}`).toBe(true);
    expect(isArrival(event.received_at), `received_at must be a Unix-millisecond safe integer (§4): ${where}`).toBe(true);
    expect(event.received_at >= previousArrival, `received_at must not decrease along seq (§4): ${where}`).toBe(true);
    previousArrival = event.received_at;
  }
  expect(isSeq(body.next), `"next" must be a non-negative integer: ${show(reply)}`).toBe(true);
  expect(typeof body.more, `"more" must be a boolean: ${show(reply)}`).toBe('boolean');
  if (body.epoch !== null) expectEpoch(body.epoch, show(reply));
  return body;
}

/** §6.3: what a group that does not exist (never written, or deleted) reads as. */
export function expectMissingGroup(page: ReadOk, since = 0): void {
  expect(page).toMatchObject({ events: [], next: since, more: false, epoch: null });
}

/** The envelope as sent: a stored envelope without the server-added `seq` and `received_at`. */
export function unsequenced(event: StoredEnvelope): Envelope {
  return { id: event.id, v: event.v, n: event.n, c: event.c };
}

/**
 * How far a `received_at` may be from this machine's clock at the append. Servers keep a clock within a minute of
 * UTC (§9); the rest allows for the machine running the suite being off too.
 */
export const CLOCK_TOLERANCE_MS = 5 * 60_000;

/** Every value lies within CLOCK_TOLERANCE_MS of [before, after], this machine's clock around the append. */
export function expectNearClock(values: readonly number[], before: number, after: number, context: string): void {
  for (const value of values) {
    expect(value, `${context}: received_at ${value} is more than 5 minutes before this machine's clock (${before})`).toBeGreaterThanOrEqual(
      before - CLOCK_TOLERANCE_MS,
    );
    expect(value, `${context}: received_at ${value} is more than 5 minutes after this machine's clock (${after})`).toBeLessThanOrEqual(
      after + CLOCK_TOLERANCE_MS,
    );
  }
}

/**
 * §4 across requests: `batches[r]` are envelopes that the request acknowledged by `acks[r]` stored (none of them a
 * duplicate), and `events` holds them all, pulled. Each request's envelopes share one `received_at`, its push
 * response reported that same value for each, and the requests' values strictly increase in `seq` order, however
 * the requests were sent.
 */
export function expectArrivalsPerRequest(events: readonly StoredEnvelope[], batches: readonly Envelope[][], acks: readonly AppendOk[]): void {
  const byId = new Map(events.map((e) => [e.id, e]));
  const requests = batches.map((batch, r) => {
    const stored = batch.map((envelope) => byId.get(envelope.id));
    const values = stored.map((e) => e?.received_at);
    expect(values, `request ${r}: every envelope one request stores gets the same received_at (§4)`).toEqual(batch.map(() => values[0]));
    expect(acks[r]?.received_at, `request ${r}: the push response reports the value pulled for each envelope (§6.2)`).toEqual(values);
    return { r, firstSeq: stored[0]?.seq ?? -1, value: values[0] ?? -1 };
  });
  requests.sort((x, y) => x.firstSeq - y.firstSeq);
  for (let i = 1; i < requests.length; i++) {
    const earlier = requests[i - 1]!;
    const later = requests[i]!;
    expect(
      later.value,
      `request ${later.r} (seq ${later.firstSeq}…) must have a greater received_at than request ${earlier.r} (seq ${earlier.firstSeq}…), stored before it (§4)`,
    ).toBeGreaterThan(earlier.value);
  }
}

/** 1, 2, …, n */
export function oneTo(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i + 1);
}
