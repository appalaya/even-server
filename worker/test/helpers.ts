/** Shared test helpers: schema and limits, fresh groups, envelopes, and a direct call into the Worker. */
import { env } from 'cloudflare:workers';
import { encode } from '../src/b64';
import type { Env } from '../src/env';
import type { Limits } from '../src/limits';
import worker from '../src/index';

/** The conformance test limits (conformance/README.md), as in wrangler.jsonc env.test. */
export const TEST_LIMITS: Limits = {
  max_event_bytes: 8192,
  max_group_bytes: 65536,
  max_group_events: 200,
  max_batch: 25,
  max_page: 50,
  retention_days: 365,
  requests_per_minute: 100000,
  writes_per_minute: 100000,
  group_creates_per_minute: 100000,
  reads_per_minute: 100000,
  daily_write_budget: 0,
};

export async function applySchema(): Promise<void> {
  for (const statement of env.TEST_SCHEMA) await env.DB.prepare(statement).run();
}

export async function seedLimits(overrides: Partial<Limits> = {}): Promise<void> {
  const values = { ...TEST_LIMITS, ...overrides };
  await env.DB.batch(
    Object.entries(values).map(([key, value]) =>
      env.DB.prepare(
        'INSERT INTO limits (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
      ).bind(key, value),
    ),
  );
}

/** Runs `body` with some limits changed, then puts the test limits back. */
export async function withLimits<T>(
  overrides: Partial<Limits>,
  body: () => Promise<T>,
): Promise<T> {
  await seedLimits(overrides);
  try {
    return await body();
  } finally {
    await seedLimits();
  }
}

export function randomB64(bytes: number): string {
  return encode(crypto.getRandomValues(new Uint8Array(bytes)));
}

export interface Group {
  groupId: string;
  token: string;
}

/** A fresh group: random 32-byte token, groupId = base64url(SHA-256(token)) (PROTOCOL.md §2). */
export async function freshGroup(): Promise<Group> {
  const token = crypto.getRandomValues(new Uint8Array(32));
  const groupId = encode(new Uint8Array(await crypto.subtle.digest('SHA-256', token)));
  return { groupId, token: encode(token) };
}

export interface WireEnvelope {
  id: string;
  v: unknown;
  n: string;
  c: string;
}

/** A structurally valid envelope with `cipherBytes` of (random) ciphertext. */
export function envelope(
  overrides: Partial<WireEnvelope> & { cipherBytes?: number } = {},
): WireEnvelope {
  const { cipherBytes = 256, ...fields } = overrides;
  return { id: randomB64(16), v: 1, n: randomB64(24), c: randomB64(cipherBytes), ...fields };
}

export interface CallOptions {
  token?: string;
  json?: unknown;
  body?: BodyInit;
  headers?: Record<string, string>;
  /** Replaces or removes (undefined) bindings for this call, e.g. a fake rate limiter. */
  env?: Partial<Env>;
}

export async function call(
  method: string,
  path: string,
  options: CallOptions = {},
): Promise<Response> {
  const headers = new Headers(options.headers);
  if (options.token !== undefined) headers.set('Authorization', `Bearer ${options.token}`);
  let body = options.body;
  if (body === undefined && options.json !== undefined) body = JSON.stringify(options.json);
  const request = new Request(`https://even.test${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body }),
  });
  // The Worker takes no ExecutionContext: it schedules nothing after the response.
  return worker.fetch(request, { ...env, ...options.env } as Env);
}

export async function append(
  group: Group,
  events: unknown[],
  options: CallOptions = {},
): Promise<Response> {
  return call('POST', `/v1/groups/${group.groupId}/events`, {
    token: group.token,
    json: { events },
    ...options,
  });
}

export async function read(group: Group, query = '', options: CallOptions = {}): Promise<Response> {
  return call('GET', `/v1/groups/${group.groupId}/events${query}`, {
    token: group.token,
    ...options,
  });
}

/** A fake Workers Rate Limiting binding that records keys and answers `success` (or a function of the key). */
export function fakeLimiter(
  success: boolean | ((key: string) => boolean) = true,
): RateLimit & { keys: string[] } {
  const keys: string[] = [];
  return {
    keys,
    async limit({ key }) {
      keys.push(key);
      return { success: typeof success === 'function' ? success(key) : success };
    },
  };
}
