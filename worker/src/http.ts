/**
 * Protocol responses (PROTOCOL.md §5, §7). Every error body is `{error, message?, index?, reason?}`; every response
 * carries `Cache-Control: no-store` (added once, in index.ts, so no path can forget it).
 */

export const JSON_TYPE = 'application/json; charset=utf-8';
export const TEXT_TYPE = 'text/plain; charset=utf-8';

export class ApiError extends Error {
  readonly status: number;
  readonly error: string;
  readonly detail: string | undefined;
  readonly index: number | undefined;
  readonly reason: string | undefined;
  readonly headers: Record<string, string>;

  constructor(
    status: number,
    error: string,
    detail?: string,
    extra: { index?: number; reason?: string; headers?: Record<string, string> } = {},
  ) {
    super(error);
    this.name = 'ApiError';
    this.status = status;
    this.error = error;
    this.detail = detail;
    this.index = extra.index;
    this.reason = extra.reason;
    this.headers = extra.headers ?? {};
  }

  response(): Response {
    const body: Record<string, unknown> = { error: this.error };
    if (this.detail !== undefined) body.message = this.detail;
    if (this.index !== undefined) body.index = this.index;
    if (this.reason !== undefined) body.reason = this.reason;
    return json(body, this.status, this.headers);
  }
}

export function invalidRequest(message: string): ApiError {
  return new ApiError(400, 'invalid_request', message);
}

export function unauthorized(message: string): ApiError {
  return new ApiError(401, 'unauthorized', message);
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': JSON_TYPE, ...headers },
  });
}

export function noContent(headers: Record<string, string> = {}): Response {
  return new Response(null, { status: 204, headers });
}

/**
 * A fixed plain-text page outside the protocol (`/`, `/robots.txt`): no protocol data, and no crawler is to index
 * it. `Cache-Control: no-store` comes from `finalize`, like every response (PROTOCOL.md §5).
 */
export function page(text: string): Response {
  return new Response(text, {
    headers: { 'Content-Type': TEXT_TYPE, 'X-Robots-Tag': 'noindex, nofollow' },
  });
}

/** Headers added to every response. CORS is permissive (§5 MAY): the only credential is a bearer token, never a cookie. */
export function finalize(response: Response): Response {
  const out = new Response(response.body, response);
  out.headers.set('Cache-Control', 'no-store');
  out.headers.set('Access-Control-Allow-Origin', '*');
  out.headers.set('Access-Control-Expose-Headers', 'Retry-After');
  return out;
}
