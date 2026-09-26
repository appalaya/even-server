/**
 * PROTOCOL.md §6.1/§7 rate limits. Opt-in (EVEN_CONFORMANCE_RATE=1): limits are per client IP and may be enforced
 * approximately, and this test deliberately gets the machine running the suite rate-limited. Run it on its own:
 *
 *   EVEN_CONFORMANCE_RATE=1 EVEN_SERVER_URL=… npx vitest run src/rate.test.ts
 */
import { describe, expect, it } from 'vitest';
import type { Reply } from './client.ts';
import { options } from './env.ts';
import { client, expectError, limits } from './harness.ts';

describe.skipIf(!options.rate())('§7 rate limiting (EVEN_CONFORMANCE_RATE=1)', () => {
  it('GET /v1/info past requests_per_minute → 429 rate_limited with Retry-After', async () => {
    const rpm = limits().rate.requests_per_minute;
    expect(rpm, 'the server publishes no request rate limit to test').toBeGreaterThan(0);
    const cap = Math.min(rpm * 3 + 100, 100_000);
    let limited: Reply | undefined;
    let sent = 0;
    while (limited === undefined && sent < cap) {
      const wave = await Promise.all(
        Array.from({ length: Math.min(50, cap - sent) }, () => client().request('GET', '/v1/info', { retryOn429: false })),
      );
      sent += wave.length;
      const unexpected = wave.find((r) => r.status !== 200 && r.status !== 429);
      expect(unexpected?.status, 'only 200 or 429 while hammering /v1/info').toBeUndefined();
      limited = wave.find((r) => r.status === 429);
    }
    expect(limited, `no 429 after ${sent} requests (published requests_per_minute = ${rpm})`).toBeDefined();
    expectError(limited!, 429, 'rate_limited');
    const retryAfter = limited!.headers.get('retry-after');
    expect(retryAfter, '429 must include Retry-After (§7)').not.toBeNull();
    const value = retryAfter!.trim();
    expect(/^\d+$/.test(value) || Number.isFinite(Date.parse(value)), `Retry-After is delta-seconds or an HTTP date: ${value}`).toBe(true);
  }, 300_000);
});
