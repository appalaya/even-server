/** PROTOCOL.md §6.1 GET /v1/info, and §9 (limits and retention are published). */
import { describe, expect, it } from 'vitest';
import { responseProblems } from './client.ts';
import { client, expectStatus } from './harness.ts';
import { infoProblems, LIMIT_NAMES, OPTIONAL_RATE_NAMES, RATE_NAMES } from './preflight.ts';

describe('§6.1 GET /v1/info', () => {
  it('answers 200 without any Authorization header, with Cache-Control: no-store and a JSON body', async () => {
    const reply = await client().info();
    expectStatus(reply, 200);
    expect(responseProblems(reply)).toEqual([]);
  });

  it('has the documented shape (protocol, limits, retention_days, push, optional operator and terms)', async () => {
    const reply = await client().info();
    expect(infoProblems(reply.json)).toEqual([]);
  });

  it('"protocol" lists the supported versions and includes 1', async () => {
    const body = (await client().info()).json as { protocol: unknown };
    expect(Array.isArray(body.protocol)).toBe(true);
    expect(body.protocol).toContain(1);
  });

  it('publishes every limit it enforces, including daily_write_budget and every rate.* (§6.1, §9)', async () => {
    const body = (await client().info()).json as { limits: Record<string, unknown> & { rate: Record<string, unknown> } };
    for (const name of LIMIT_NAMES) {
      expect(Number.isSafeInteger(body.limits[name]) && (body.limits[name] as number) >= 0, `limits.${name}`).toBe(true);
    }
    for (const name of RATE_NAMES) {
      expect(Number.isSafeInteger(body.limits.rate[name]) && (body.limits.rate[name] as number) >= 0, `limits.rate.${name}`).toBe(true);
    }
    for (const name of OPTIONAL_RATE_NAMES) {
      const value = body.limits.rate[name];
      if (value !== undefined) expect(Number.isSafeInteger(value) && (value as number) >= 0, `limits.rate.${name}`).toBe(true);
    }
  });

  it('"push" is a boolean stating whether §6.5 is implemented', async () => {
    const body = (await client().info()).json as { push: unknown };
    expect(typeof body.push).toBe('boolean');
  });

  it('publishes retention_days (§9)', async () => {
    const body = (await client().info()).json as { retention_days: unknown };
    expect(Number.isSafeInteger(body.retention_days) && (body.retention_days as number) >= 0).toBe(true);
  });
});
