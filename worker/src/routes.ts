/**
 * The HTTP surface (PROTOCOL.md §6). Routing is a handful of comparisons against the path; a router would be the
 * largest dependency in the project (design.md, "The Worker").
 */
import { authenticate, checkGroupId } from './auth';
import * as b64 from './b64';
import * as store from './db';
import type { Env } from './env';
import { firstOccurrences, parseAppendBody } from './envelope';
import { ApiError, invalidRequest, json, noContent } from './http';
import { driftFromVars, infoDocument, maxBodyBytes, type Limits } from './limits';
import { logEvent } from './log';
import { allow, clientKey, rateLimited } from './ratelimit';

export type RouteKind = 'info' | 'events' | 'group' | 'subscriptions';

export interface Route {
  kind: RouteKind;
  /** The route pattern: the only form of the path that is ever logged. */
  pattern: string;
  methods: readonly string[];
  /** The raw `{groupId}` path segment (group routes only). Validated in the prelude, never logged. */
  groupId?: string;
}

/** The route for `pathname`, or undefined (→ 404). Exact matches only: `/v1/info/` is not `/v1/info`. */
export function matchRoute(pathname: string): Route | undefined {
  if (pathname === '/v1/info') return { kind: 'info', pattern: '/v1/info', methods: ['GET'] };
  const parts = pathname.split('/'); // ['', 'v1', 'groups', '{groupId}', ...]
  if (parts[1] !== 'v1' || parts[2] !== 'groups' || parts[3] === undefined || parts[3] === '')
    return undefined;
  const groupId = parts[3];
  if (parts.length === 4)
    return { kind: 'group', pattern: '/v1/groups/{groupId}', methods: ['DELETE'], groupId };
  if (parts.length !== 5) return undefined;
  if (parts[4] === 'events')
    return {
      kind: 'events',
      pattern: '/v1/groups/{groupId}/events',
      methods: ['GET', 'POST'],
      groupId,
    };
  if (parts[4] === 'subscriptions') {
    return {
      kind: 'subscriptions',
      pattern: '/v1/groups/{groupId}/subscriptions',
      methods: ['PUT'],
      groupId,
    };
  }
  return undefined;
}

export async function handle(
  request: Request,
  env: Env,
  url: URL,
  route: Route,
): Promise<Response> {
  const method = request.method;
  if (method === 'OPTIONS') return corsPreflight(route);
  if (!route.methods.includes(method)) {
    throw new ApiError(405, 'method_not_allowed', undefined, {
      headers: { Allow: route.methods.join(', ') },
    });
  }
  switch (route.kind) {
    case 'info':
      return info(request, env);
    case 'events':
      return method === 'POST'
        ? appendEvents(request, env, route)
        : readEvents(request, env, url, route);
    case 'group':
      return deleteGroup(request, env, route);
    case 'subscriptions':
      await prelude(request, env, route);
      throw new ApiError(
        501,
        'not_implemented',
        'push subscriptions are not implemented by this server',
      );
  }
}

function corsPreflight(route: Route): Response {
  return noContent({
    Allow: route.methods.join(', '),
    'Access-Control-Allow-Methods': route.methods.join(', '),
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
  });
}

// ---------- prelude (design.md, "Request handling") ----------

interface Prelude {
  groupId: string;
  state: store.GroupState;
  key: string;
}

/**
 * Every group-scoped request: groupId shape (400), bearer token (401), blocklist (410), then the per-IP request
 * limiter (429). Auth runs before anything that touches the database or a limiter, so an unauthenticated flood
 * cannot consume a real group's creation budget or learn whether it exists.
 */
async function prelude(request: Request, env: Env, route: Route, day?: string): Promise<Prelude> {
  const groupId = decodeSegment(route.groupId ?? '');
  checkGroupId(groupId);
  await authenticate(groupId, request.headers.get('Authorization'));
  const state = await store.groupState(env.DB, groupId, day);
  checkDrift(state.limits, env);
  if (state.blocked)
    throw new ApiError(410, 'group_blocked', 'this group is blocked on this server');
  const key = clientKey(request);
  if (!(await allow(env.RATE_REQUESTS, 'RATE_REQUESTS', key))) throw rateLimited();
  return { groupId, state, key };
}

/** Percent-decoding as a framework would; a malformed escape stays as is and fails the groupId check. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

let driftChecked = false;

/** Once per isolate: warn if the limits table no longer matches this deployment's vars (a missed re-seed). */
function checkDrift(limits: Limits, env: Env): void {
  if (driftChecked) return;
  driftChecked = true;
  const keys = driftFromVars(limits, env);
  if (keys.length > 0) {
    logEvent('warn', 'limits_table_differs_from_vars', {
      keys,
      effect:
        'the table is published and enforced; re-seed it (npm run db:seed:remote) to apply the vars',
    });
  }
}

// ---------- §6.1 info ----------

async function info(request: Request, env: Env): Promise<Response> {
  const limits = await store.loadLimits(env.DB);
  checkDrift(limits, env);
  if (!(await allow(env.RATE_REQUESTS, 'RATE_REQUESTS', clientKey(request)))) throw rateLimited();
  return json(infoDocument(limits, env.EVEN_OPERATOR, env.EVEN_TERMS_URL));
}

// ---------- §6.2 append ----------

async function appendEvents(request: Request, env: Env, route: Route): Promise<Response> {
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const { groupId, state, key } = await prelude(request, env, route, day);
  const { limits } = state;

  const envelopes = parseAppendBody(await readJsonBody(request, maxBodyBytes(limits)), limits);

  if (!(await allow(env.RATE_WRITES, 'RATE_WRITES', key))) throw rateLimited();
  if (!state.exists && !(await allow(env.RATE_CREATES, 'RATE_CREATES', key))) throw rateLimited();

  // Checked against the count read in the prelude and incremented inside the append batch: concurrent appends at
  // the boundary can pass it by at most the number in flight, which does not matter for a quota guard.
  if (limits.daily_write_budget > 0 && state.writesToday >= limits.daily_write_budget) {
    throw new ApiError(
      503,
      'over_budget',
      "the server's daily write budget is exhausted; reads still work",
      {
        headers: { 'Retry-After': String(secondsUntilUtcMidnight(now)) },
      },
    );
  }

  const unique = firstOccurrences(envelopes);
  let result: store.AppendResult;
  try {
    result = await store.append(env.DB, groupId, unique, {
      epoch: newEpoch(),
      nowMs: now.getTime(),
      day,
    });
  } catch (error) {
    if (!(error instanceof store.GroupFull)) throw error;
    const reason = await store.fullReason(env.DB, groupId, unique, limits);
    const detail =
      reason === undefined
        ? 'write would exceed max_group_bytes or max_group_events'
        : `write would exceed max_group_${reason} (${reason === 'bytes' ? limits.max_group_bytes : limits.max_group_events})`;
    throw new ApiError(413, 'group_full', detail, reason === undefined ? {} : { reason });
  }
  return json({
    accepted: result.accepted,
    duplicates: envelopes.length - result.accepted,
    seq: result.seq,
    epoch: result.epoch,
  });
}

/** Reads at most `maxBytes` of body and parses it as JSON; anything else is `400 invalid_request`. */
async function readJsonBody(request: Request, maxBytes: number): Promise<unknown> {
  const tooLarge = (): ApiError => invalidRequest('body is larger than any valid batch');
  const declared = request.headers.get('Content-Length');
  if (declared !== null && /^[0-9]+$/.test(declared) && Number(declared) > maxBytes)
    throw tooLarge();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (request.body !== null) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw tooLarge();
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    // fatal: invalid UTF-8 is a 400. ignoreBOM keeps a leading BOM in the text, where JSON.parse rejects it, as
    // the Python reference does.
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes),
    ) as unknown;
  } catch {
    throw invalidRequest('body is not a JSON document');
  }
}

/** §6.6: 16 random bytes, 22 base64url characters. */
function newEpoch(): string {
  return b64.encode(crypto.getRandomValues(new Uint8Array(16)));
}

function secondsUntilUtcMidnight(now: Date): number {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((midnight - now.getTime()) / 1000));
}

// ---------- §6.3 read ----------

const QUERY_INT = /^-?[0-9]{1,4000}$/;

async function readEvents(request: Request, env: Env, url: URL, route: Route): Promise<Response> {
  const { groupId, state } = await prelude(request, env, route);
  const maxPage = state.limits.max_page;
  const since = queryInt(url, 'since', 0);
  const limit = queryInt(url, 'limit', maxPage);
  // seq values are JSON numbers read by JavaScript clients, so a cursor beyond 2^53 − 1 cannot be one we issued.
  if (since < 0 || since > Number.MAX_SAFE_INTEGER)
    throw invalidRequest('since must be a non-negative integer');
  if (limit < 1) throw invalidRequest('limit must be at least 1');
  const page = await store.read(env.DB, groupId, since, Math.min(limit, maxPage));
  return json({
    events: page.events,
    next: page.events.at(-1)?.seq ?? since,
    more: page.more,
    epoch: page.epoch,
  });
}

function queryInt(url: URL, name: string, fallback: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  if (!QUERY_INT.test(raw)) throw invalidRequest(`${name} must be an integer`);
  return Number(raw); // may be ±Infinity for absurd lengths; the range checks above handle that
}

// ---------- §6.4 delete ----------

async function deleteGroup(request: Request, env: Env, route: Route): Promise<Response> {
  const { groupId } = await prelude(request, env, route);
  await store.deleteGroup(env.DB, groupId);
  return noContent();
}
