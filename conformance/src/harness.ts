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

/** §6.2 response: 200 with integer accepted, duplicates and seq, and an epoch. `sent` checks accepted + duplicates. */
export function expectAppendOk(reply: Reply, sent?: number): AppendOk {
  expectStatus(reply, 200);
  expect(isRecord(reply.json), show(reply)).toBe(true);
  const body = reply.json as AppendOk;
  for (const field of ['accepted', 'duplicates', 'seq'] as const) {
    expect(isSeq(body[field]), `"${field}" must be a non-negative integer: ${show(reply)}`).toBe(true);
  }
  expectEpoch(body.epoch, show(reply));
  if (sent !== undefined) {
    expect(body.accepted + body.duplicates, `accepted + duplicates must equal the envelopes sent: ${show(reply)}`).toBe(sent);
  }
  return body;
}

/** §6.3 response: 200, events ascending by seq with {seq, id, v, n, c}, integer next, boolean more, epoch or null. */
export function expectReadOk(reply: Reply): ReadOk {
  expectStatus(reply, 200);
  expect(isRecord(reply.json), show(reply)).toBe(true);
  const body = reply.json as ReadOk;
  expect(Array.isArray(body.events), `"events" must be an array: ${show(reply)}`).toBe(true);
  let previous = 0;
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

/** The envelope as sent: a stored envelope without the server-added `seq`. */
export function unsequenced(event: StoredEnvelope): Envelope {
  return { id: event.id, v: event.v, n: event.n, c: event.c };
}

/** 1, 2, …, n */
export function oneTo(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i + 1);
}
