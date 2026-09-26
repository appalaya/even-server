/**
 * Logging: one JSON object per line via console.log (Workers Logs keeps these; invocation logs are off in
 * wrangler.jsonc because they record the URL).
 *
 * Request lines carry exactly method, route pattern, status, duration, and whether the request was rate-limited.
 * Never a URL, token, body, group id, or IP (PROTOCOL.md §9, THREAT-MODEL.md "What we log"). Nothing else in the
 * Worker calls console.* directly, so this file is the whole log surface.
 */

const KNOWN_METHODS: ReadonlySet<string> = new Set([
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'DELETE',
  'PATCH',
  'OPTIONS',
]);

/**
 * `ms` is wall time. In Workers the clock advances only across I/O (a Spectre mitigation), so this is time spent
 * waiting on D1 and the rate limiter, not CPU time.
 */
export function logRequest(method: string, route: string | null, status: number, ms: number): void {
  console.log(
    JSON.stringify({
      method: KNOWN_METHODS.has(method) ? method : 'OTHER',
      route,
      status,
      ms,
      limited: status === 429,
    }),
  );
}

/** Operational events (expiry, fail-closed limits, missing bindings). Callers pass only non-identifying fields. */
export function logEvent(
  level: 'info' | 'warn' | 'error',
  event: string,
  fields: Record<string, unknown> = {},
): void {
  const line = JSON.stringify({ level, event, ...fields });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

/** An unhandled exception: its type only. Messages and stacks can carry request data, so they stay out. */
export function logException(route: string | null, error: unknown): void {
  logEvent('error', 'unhandled_exception', {
    route,
    exception: error instanceof Error ? error.name : typeof error,
  });
}
