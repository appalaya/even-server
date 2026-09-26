/**
 * Per-IP rate limits (design.md, "Rate limiting") through three Workers Rate Limiting bindings with 60-second
 * periods: all requests, append requests, and group creations. Keyed by CF-Connecting-IP, IPv6 by its /64.
 *
 * The limits are approximate and per Cloudflare location, which is fine for abuse control. The key goes to the
 * platform's limiter and nowhere else: it is never logged and never stored in D1.
 */
import { ApiError } from './http';
import { logEvent } from './log';
import { RATE_PERIOD_SECONDS } from './vars';

export type LimiterName = 'RATE_REQUESTS' | 'RATE_WRITES' | 'RATE_CREATES';

export function rateLimited(): ApiError {
  // The binding does not say when its window ends; a full period is the honest upper bound.
  return new ApiError(429, 'rate_limited', 'per-IP rate limit exceeded', {
    headers: { 'Retry-After': String(RATE_PERIOD_SECONDS) },
  });
}

/** The client's rate-limit key: CF-Connecting-IP, which Cloudflare sets and a client cannot forge through it. */
export function clientKey(request: Request): string {
  const address = request.headers.get('CF-Connecting-IP');
  return address === null || address.trim() === '' ? 'unknown' : ipKey(address);
}

/**
 * IPv4 as is; IPv6 by its /64 (`2001:db8:1:2::/64`); IPv4-mapped IPv6 as the IPv4 address. Anything unparseable is
 * used verbatim.
 */
export function ipKey(address: string): string {
  const trimmed = address.trim();
  if (!trimmed.includes(':')) return trimmed;
  const groups = parseIpv6(trimmed);
  if (groups === undefined) return trimmed;
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    const [hi = 0, lo = 0] = groups.slice(6);
    return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join('.');
  }
  return `${groups
    .slice(0, 4)
    .map((g) => g.toString(16))
    .join(':')}::/64`;
}

/** Eight 16-bit groups, or undefined. Handles `::` compression, a zone suffix and a trailing dotted IPv4. */
function parseIpv6(text: string): number[] | undefined {
  const address = text.replace(/%.*$/, '').toLowerCase();
  const halves = address.split('::');
  if (halves.length > 2) return undefined;
  const parse = (part: string): number[] | undefined => {
    if (part === '') return [];
    const out: number[] = [];
    const pieces = part.split(':');
    for (const [i, piece] of pieces.entries()) {
      if (i === pieces.length - 1 && piece.includes('.')) {
        const octets = piece.split('.');
        if (octets.length !== 4 || !octets.every((o) => /^[0-9]{1,3}$/.test(o) && Number(o) <= 255))
          return undefined;
        const [a, b, c, d] = octets.map(Number) as [number, number, number, number];
        out.push((a << 8) | b, (c << 8) | d);
      } else if (/^[0-9a-f]{1,4}$/.test(piece)) {
        out.push(parseInt(piece, 16));
      } else {
        return undefined;
      }
    }
    return out;
  };
  const head = parse(halves[0] ?? '');
  const tail = halves.length === 2 ? parse(halves[1] ?? '') : [];
  if (head === undefined || tail === undefined) return undefined;
  if (halves.length === 1) return head.length === 8 ? head : undefined;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return undefined;
  return [...head, ...new Array<number>(missing).fill(0), ...tail];
}

const warned = new Set<string>();

/**
 * One hit against `limiter` for `key`. True if allowed. A missing binding, or a limiter call that fails, allows the
 * request (design.md: a self-deployed Worker without the bindings still works) and is logged once per isolate.
 */
export async function allow(
  limiter: RateLimit | undefined,
  name: LimiterName,
  key: string,
): Promise<boolean> {
  if (limiter === undefined) {
    warnOnce(name, 'ratelimit_binding_missing');
    return true;
  }
  try {
    return (await limiter.limit({ key })).success;
  } catch (error) {
    warnOnce(name, 'ratelimit_binding_failed', error);
    return true;
  }
}

function warnOnce(binding: LimiterName, event: string, error?: unknown): void {
  if (warned.has(`${event}:${binding}`)) return;
  warned.add(`${event}:${binding}`);
  logEvent('warn', event, {
    binding,
    ...(error === undefined
      ? {}
      : { exception: error instanceof Error ? error.name : typeof error }),
    effect: 'requests this limiter would count are allowed',
  });
}
