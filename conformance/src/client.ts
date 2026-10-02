/**
 * A minimal typed HTTP client for the Even sync protocol (PROTOCOL.md §5–§7), built on global fetch.
 *
 * Every response is checked against the transport rules that apply to all responses: `Cache-Control: no-store`
 * (§5, a MUST) and a JSON body with a JSON content type (§5, §7). Violations are recorded, and the setup file fails
 * the test that received them, so every test in the suite also checks the headers of every response it saw.
 *
 * Like a well-behaved client (§10), it honours `Retry-After` on 429 unless told not to, so a server with low rate
 * limits makes the suite slow rather than wrong. Redirects are not followed: a documented route must answer itself.
 */
import type { Envelope } from './keys.ts';

export interface RateLimits {
  requests_per_minute: number;
  writes_per_minute: number;
  group_creates_per_minute: number;
  /** Optional (§6.1): published only by servers that limit event reads separately. */
  reads_per_minute?: number;
}

export interface Limits {
  max_event_bytes: number;
  max_group_bytes: number;
  max_group_events: number;
  max_batch: number;
  max_page: number;
  daily_write_budget: number;
  rate: RateLimits;
}

export interface Info {
  protocol: number[];
  limits: Limits;
  retention_days: number;
  push: boolean;
  operator?: string;
  terms?: string;
}

export interface StoredEnvelope extends Envelope {
  seq: number;
}

export interface AppendOk {
  accepted: number;
  duplicates: number;
  seq: number;
  epoch: string;
}

export interface ReadOk {
  events: StoredEnvelope[];
  next: number;
  more: boolean;
  epoch: string | null;
}

export interface ErrorBody {
  error: string;
  message?: string;
  index?: number;
  reason?: string;
}

export interface Reply {
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
  /** The parsed body, or undefined if the body was empty or not JSON. */
  readonly json: unknown;
}

export interface RequestOptions {
  /** Sends `Authorization: Bearer <bearer>`. */
  bearer?: string;
  /** Sends this exact Authorization header value (overrides `bearer`). */
  authorization?: string;
  /** JSON-encodes this as the body. */
  json?: unknown;
  /** Sends this exact body (overrides `json`). */
  body?: string;
  /** Content-Type for a request with a body. Default `application/json; charset=utf-8` (§5). */
  contentType?: string;
  /** Honour Retry-After on 429 and retry (default true). The rate-limit test turns this off. */
  retryOn429?: boolean;
}

export interface ReadQuery {
  since?: number | string;
  limit?: number | string;
}

// ---------- response header checks ----------

export interface HeaderViolation {
  request: string;
  status: number;
  problem: string;
}

const violations: HeaderViolation[] = [];

/** Returns and clears the violations recorded since the last call. */
export function takeHeaderViolations(): HeaderViolation[] {
  return violations.splice(0, violations.length);
}

/** Problems with a response under §5/§7, whatever its status. Empty means it complies. */
export function responseProblems(reply: Pick<Reply, 'status' | 'headers' | 'text' | 'json'>): string[] {
  const problems: string[] = [];
  const cacheControl = reply.headers.get('cache-control');
  if (cacheControl === null || !/(^|,)\s*no-store\s*(,|$)/i.test(cacheControl)) {
    problems.push(`Cache-Control must be no-store (§5), got ${JSON.stringify(cacheControl)}`);
  }
  if (reply.status === 204) {
    if (reply.text !== '') problems.push('a 204 response must have an empty body');
    return problems;
  }
  const contentType = reply.headers.get('content-type');
  const [mediaType = '', ...params] = (contentType ?? '').split(';').map((part) => part.trim().toLowerCase());
  if (mediaType !== 'application/json') {
    problems.push(`Content-Type must be application/json (§5), got ${JSON.stringify(contentType)}`);
  }
  const charset = params.find((p) => p.startsWith('charset='));
  if (charset !== undefined && charset.replace(/^charset=/, '').replace(/"/g, '') !== 'utf-8') {
    problems.push(`a Content-Type charset, when present, must be utf-8 (§5), got ${JSON.stringify(contentType)}`);
  }
  if (reply.json === undefined) problems.push(`the body must be JSON (§5, §7), got ${JSON.stringify(reply.text.slice(0, 120))}`);
  return problems;
}

// ---------- client ----------

const MAX_429_RETRIES = 5;
const MAX_RETRY_WAIT_MS = 65_000;

function retryAfterMs(header: string | null): number {
  if (header !== null) {
    const seconds = Number(header.trim());
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(Math.max(seconds * 1000, 250), MAX_RETRY_WAIT_MS);
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.min(Math.max(date - Date.now(), 250), MAX_RETRY_WAIT_MS);
  }
  return 1000;
}

export class EvenClient {
  readonly base: string;
  readonly timeoutMs: number;

  constructor(base: string, timeoutMs = 20_000) {
    this.base = base;
    this.timeoutMs = timeoutMs;
  }

  async request(method: string, path: string, options: RequestOptions = {}): Promise<Reply> {
    for (let attempt = 0; ; attempt++) {
      const reply = await this.once(method, path, options);
      if (reply.status !== 429 || options.retryOn429 === false || attempt >= MAX_429_RETRIES) return reply;
      await new Promise((resolve) => setTimeout(resolve, retryAfterMs(reply.headers.get('retry-after'))));
    }
  }

  private async once(method: string, path: string, options: RequestOptions): Promise<Reply> {
    const headers: Record<string, string> = { accept: 'application/json' };
    const authorization = options.authorization ?? (options.bearer === undefined ? undefined : `Bearer ${options.bearer}`);
    if (authorization !== undefined) headers.authorization = authorization;
    const body = options.body ?? (options.json === undefined ? undefined : JSON.stringify(options.json));
    if (body !== undefined) headers['content-type'] = options.contentType ?? 'application/json; charset=utf-8';

    const url = this.base + path;
    let response: Response;
    try {
      response = await fetch(url, { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (error) {
      throw new Error(`${method} ${url} failed without a response (${describeFailure(error)})`);
    }
    const text = await response.text();
    let json: unknown;
    try {
      json = text === '' ? undefined : (JSON.parse(text) as unknown);
    } catch {
      json = undefined;
    }
    const reply: Reply = { method, path, status: response.status, headers: response.headers, text, json };
    for (const problem of responseProblems(reply)) {
      violations.push({ request: `${method} ${path}`, status: reply.status, problem });
    }
    return reply;
  }

  info(): Promise<Reply> {
    return this.request('GET', '/v1/info');
  }

  /** POST /v1/groups/{groupId}/events with body `{ events }`. */
  append(groupId: string, token: string | undefined, events: readonly unknown[], options: RequestOptions = {}): Promise<Reply> {
    return this.request('POST', `/v1/groups/${groupId}/events`, { ...withBearer(token), json: { events }, ...options });
  }

  /** POST /v1/groups/{groupId}/events with an arbitrary body (JSON value, or a raw string via options.body). */
  appendBody(groupId: string, token: string | undefined, options: RequestOptions): Promise<Reply> {
    return this.request('POST', `/v1/groups/${groupId}/events`, { ...withBearer(token), ...options });
  }

  /** GET /v1/groups/{groupId}/events?since=&limit= (parameters omitted when undefined, passed verbatim otherwise). */
  read(groupId: string, token: string | undefined, query: ReadQuery = {}, options: RequestOptions = {}): Promise<Reply> {
    const params: string[] = [];
    if (query.since !== undefined) params.push(`since=${encodeURIComponent(String(query.since))}`);
    if (query.limit !== undefined) params.push(`limit=${encodeURIComponent(String(query.limit))}`);
    const qs = params.length === 0 ? '' : `?${params.join('&')}`;
    return this.request('GET', `/v1/groups/${groupId}/events${qs}`, { ...withBearer(token), ...options });
  }

  /** DELETE /v1/groups/{groupId} */
  deleteGroup(groupId: string, token: string | undefined, options: RequestOptions = {}): Promise<Reply> {
    return this.request('DELETE', `/v1/groups/${groupId}`, { ...withBearer(token), ...options });
  }

  /** PUT /v1/groups/{groupId}/subscriptions (reserved, §6.5). */
  subscribe(groupId: string, token: string | undefined, body: unknown = {}, options: RequestOptions = {}): Promise<Reply> {
    return this.request('PUT', `/v1/groups/${groupId}/subscriptions`, { ...withBearer(token), json: body, ...options });
  }
}

/** fetch reports "fetch failed" and hides the useful part (ECONNREFUSED, a TLS error, a timeout) in `cause`. */
function describeFailure(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause as { code?: unknown; message?: unknown } | undefined;
  const detail = cause === undefined ? '' : ` — ${typeof cause.code === 'string' ? cause.code : String(cause.message)}`;
  return `${error.name}: ${error.message}${detail}`;
}

function withBearer(token: string | undefined): RequestOptions {
  return token === undefined ? {} : { bearer: token };
}
