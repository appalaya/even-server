/**
 * The Worker end to end inside workerd, against a real (in-memory) D1 with schema.sql applied: the paths the
 * conformance suite cannot reach from outside (fail-closed limits, the daily budget, rate-limit bindings, logging,
 * expiry), plus the core round trip as a sanity check. The conformance suite remains the definition of correctness.
 */
import { createScheduledController } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as store from '../src/db';
import { firstOccurrences, parseAppendBody } from '../src/envelope';
import worker, { expireIdleGroups } from '../src/index';
import { readUnits } from '../src/ratelimit';
import {
  allowanceLimiter,
  append,
  call,
  envelope,
  fakeLimiter,
  fill,
  freshGroup,
  read,
  seedLimits,
  withLimits,
  type Group,
} from './helpers';

/** Every line the Worker logs during a test, parsed. */
let lines: Array<Record<string, unknown>>;
let raw: string[];

beforeEach(() => {
  lines = [];
  raw = [];
  for (const method of ['log', 'warn', 'error', 'info', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      const text = args.map(String).join(' ');
      raw.push(text);
      try {
        lines.push(JSON.parse(text) as Record<string, unknown>);
      } catch {
        lines.push({ unparsed: text });
      }
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

const requestLines = (): Array<Record<string, unknown>> =>
  lines.filter((line) => 'route' in line && 'status' in line && !('event' in line));

async function body<T = Record<string, unknown>>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

describe('append, read, delete', () => {
  it('round-trips, assigns seq 1..n, and recreates with a new epoch after delete', async () => {
    const group = await freshGroup();
    const sent = [envelope(), envelope(), envelope()];
    const before = Date.now();
    const first = await body<{ epoch: string; received_at: number[] }>(await append(group, sent));
    expect(first).toMatchObject({ accepted: 3, duplicates: 0, seq: 3 });
    expect(first.epoch).toMatch(/^[A-Za-z0-9_-]{22}$/);
    // The same field order as the Python reference: the two agree byte for byte in shape.
    expect(Object.keys(first)).toEqual(['accepted', 'duplicates', 'seq', 'epoch', 'received_at']);
    const [arrival] = first.received_at;
    expect(first.received_at).toEqual([arrival, arrival, arrival]);
    expect(arrival).toBeGreaterThanOrEqual(before);
    expect(arrival).toBeLessThanOrEqual(Date.now());

    const page = await body<{ events: Array<Record<string, unknown>> }>(await read(group));
    expect(page).toMatchObject({ next: 3, more: false, epoch: first.epoch });
    expect(page.events).toEqual(sent.map((e, i) => ({ seq: i + 1, ...e, received_at: arrival })));
    expect(Object.keys(page.events[0] ?? {})).toEqual(['seq', 'id', 'v', 'n', 'c', 'received_at']);

    expect(
      (await call('DELETE', `/v1/groups/${group.groupId}`, { token: group.token })).status,
    ).toBe(204);
    expect(await body(await read(group))).toEqual({
      events: [],
      next: 0,
      more: false,
      epoch: null,
    });
    const again = await body(await append(group, sent.slice(0, 1)));
    expect(again).toMatchObject({ accepted: 1, duplicates: 0, seq: 1 });
    expect(again.epoch).not.toBe(first.epoch);
  });

  it('counts in-request and cross-request duplicates without consuming seq', async () => {
    const group = await freshGroup();
    const a = envelope();
    expect(await body(await append(group, [a, envelope({ id: a.id }), a]))).toMatchObject({
      accepted: 1,
      duplicates: 2,
      seq: 1,
    });
    expect(await body(await append(group, [envelope(), a]))).toMatchObject({
      accepted: 1,
      duplicates: 1,
      seq: 2,
    });
  });

  it('received_at: max(now, the previous request + 1), one value per request, the stored one for a duplicate, fresh after delete', async () => {
    const group = await freshGroup();
    const day = '2041-01-01';
    const at = async (events: ReturnType<typeof envelope>[], nowMs: number): Promise<number[]> => {
      const parsed = parseAppendBody({ events }, { max_batch: 25, max_event_bytes: 8192 });
      const result = await store.append(env.DB, group.groupId, firstOccurrences(parsed), {
        epoch: 'E'.repeat(22),
        nowMs,
        day,
      });
      return parsed.map((e) => result.receivedAt.get(e.id) ?? -1);
    };
    const lastWriteAt = async (): Promise<unknown> =>
      env.DB.prepare('SELECT last_write_at FROM groups WHERE id = ?')
        .bind(group.groupId)
        .first('last_write_at');
    const [a, b, c, d, e] = [envelope(), envelope(), envelope(), envelope(), envelope()];
    try {
      expect(await at([a, b, a], 5_000)).toEqual([5_000, 5_000, 5_000]);
      // A clock behind the last request, then one equal to it: each request still arrives after the one before.
      expect(await at([c, a, envelope({ id: c.id })], 4_000)).toEqual([5_001, 5_000, 5_001]);
      expect(await at([d], 5_001)).toEqual([5_002]);
      expect(await at([e], 9_000)).toEqual([9_000]);
      // Duplicates only: the stored values, and nothing moves.
      expect(await at([e, d, c, b, a], 20_000)).toEqual([9_000, 5_002, 5_001, 5_000, 5_000]);
      expect(await lastWriteAt()).toBe(9_000);
      const page = await body<{ events: Array<{ id: string; received_at: number }> }>(
        await read(group),
      );
      expect(page.events.map((event) => [event.id, event.received_at])).toEqual([
        [a.id, 5_000],
        [b.id, 5_000],
        [c.id, 5_001],
        [d.id, 5_002],
        [e.id, 9_000],
      ]);
      // Deleted and recreated: assigned afresh from the clock, not continued from the old incarnation.
      await call('DELETE', `/v1/groups/${group.groupId}`, { token: group.token });
      expect(await at([a, b], 1_000)).toEqual([1_000, 1_000]);
      expect(await lastWriteAt()).toBe(1_000);
    } finally {
      await env.DB.prepare('DELETE FROM counters WHERE day = ?').bind(day).run();
    }
  });

  it('stores v: 1.0 as the integer 1', async () => {
    const group = await freshGroup();
    const text = JSON.stringify({ events: [envelope()] }).replace('"v":1', '"v":1.0');
    const response = await call('POST', `/v1/groups/${group.groupId}/events`, {
      token: group.token,
      body: text,
    });
    expect(response.status).toBe(200);
    const page = await body<{ events: Array<{ v: unknown }> }>(await read(group));
    expect(page.events[0]?.v).toBe(1);
  });

  it('clamps limit to max_page, rejects since beyond 2^53 − 1, and accepts absurdly large limits', async () => {
    const group = await freshGroup();
    await withLimits({ max_page: 2 }, async () => {
      await append(group, [envelope(), envelope(), envelope()]);
      expect(await body(await read(group, `?limit=${'9'.repeat(400)}`))).toMatchObject({
        next: 2,
        more: true,
      });
      expect((await read(group, '?since=9007199254740992')).status).toBe(400);
      expect(await body(await read(group, '?since=9007199254740991'))).toMatchObject({
        events: [],
        next: 9007199254740991,
      });
    });
  });

  it('rejects an oversized body before parsing it, and invalid UTF-8 or a BOM as invalid_request', async () => {
    const group = await freshGroup();
    const path = `/v1/groups/${group.groupId}/events`;
    const huge = await call('POST', path, {
      token: group.token,
      body: `{"events":[${'"x",'.repeat(400_000)}"x"]}`,
    });
    expect(huge.status).toBe(400);
    expect(await body(huge)).toMatchObject({ error: 'invalid_request' });
    const invalid = await call('POST', path, {
      token: group.token,
      body: new Uint8Array([0x7b, 0xff, 0x7d]),
    });
    expect(await body(invalid)).toMatchObject({ error: 'invalid_request' });
    const bom = await call('POST', path, {
      token: group.token,
      body: `﻿${JSON.stringify({ events: [envelope()] })}`,
    });
    expect(bom.status).toBe(400);
  });
});

describe('caps (triggers)', () => {
  it('413 group_full with reason, nothing stored, and the day counter rolled back with the batch', async () => {
    const group = await freshGroup();
    await withLimits({ max_group_bytes: 1000, max_group_events: 3 }, async () => {
      const day = new Date().toISOString().slice(0, 10);
      const counter = async (): Promise<unknown> =>
        (
          await env.DB.prepare('SELECT writes FROM counters WHERE day = ?')
            .bind(day)
            .first<{ writes: number }>()
        )?.writes;

      const big = await append(group, [
        envelope({ cipherBytes: 600 }),
        envelope({ cipherBytes: 600 }),
      ]);
      expect(big.status).toBe(413);
      expect(await body(big)).toMatchObject({ error: 'group_full', reason: 'bytes' });
      expect(await body(await read(group))).toMatchObject({ events: [], epoch: null });

      const stored = [
        envelope({ cipherBytes: 17 }),
        envelope({ cipherBytes: 17 }),
        envelope({ cipherBytes: 17 }),
      ];
      expect(await body(await append(group, stored))).toMatchObject({ accepted: 3, seq: 3 });
      const before = await counter();
      const many = await append(group, [stored[0], envelope({ cipherBytes: 17 })]);
      expect(many.status).toBe(413);
      expect(await body(many)).toMatchObject({ error: 'group_full', reason: 'events' });
      expect(await counter()).toBe(before);
      // Duplicates only, against a full group: 200.
      expect(await body(await append(group, stored))).toMatchObject({
        accepted: 0,
        duplicates: 3,
        seq: 3,
      });

      const row = await env.DB.prepare('SELECT bytes, events FROM groups WHERE id = ?')
        .bind(group.groupId)
        .first();
      expect(row).toEqual({ bytes: 3 * (17 + 64), events: 3 });
    });
  });

  it('the cap trigger fails closed when a cap row is missing', async () => {
    const group = await freshGroup();
    await append(group, [envelope()]);
    try {
      await env.DB.prepare("DELETE FROM limits WHERE key = 'max_group_events'").run();
      const insert = env.DB.prepare(
        "INSERT INTO events (group_id, seq, id, v, n, c, size, created_at) VALUES (?, 99, 'AAAAAAAAAAAAAAAAAAAAAA', 1, 'n', 'c', 81, 0)",
      ).bind(group.groupId);
      await expect(insert.run()).rejects.toThrow(/group_full/);
    } finally {
      await seedLimits();
    }
  });
});

describe('limits table', () => {
  it('a missing row → 500 server_error on every route that needs limits, logged by key, never guessed', async () => {
    const group = await freshGroup();
    try {
      await env.DB.prepare("DELETE FROM limits WHERE key = 'max_batch'").run();
      for (const response of [
        await call('GET', '/v1/info'),
        await append(group, [envelope()]),
        await read(group),
      ]) {
        expect(response.status).toBe(500);
        expect(await body(response)).toEqual({ error: 'server_error' });
      }
      const failures = lines.filter((line) => line.event === 'limits_missing');
      expect(failures).toHaveLength(3);
      expect(failures[0]).toMatchObject({ level: 'error', missing: ['max_batch'] });
    } finally {
      await seedLimits();
    }
  });

  it('/v1/info publishes the table, not the vars', async () => {
    await withLimits({ max_page: 7, daily_write_budget: 12 }, async () => {
      const info = await body<{ limits: Record<string, unknown> }>(await call('GET', '/v1/info'));
      expect(info.limits).toMatchObject({ max_page: 7, daily_write_budget: 12 });
    });
  });
});

describe('daily write budget', () => {
  const today = (): string => new Date().toISOString().slice(0, 10);
  const counter = async (day = today()): Promise<number> =>
    (
      await env.DB.prepare('SELECT writes FROM counters WHERE day = ?')
        .bind(day)
        .first<{ writes: number }>()
    )?.writes ?? 0;

  it('past the budget, appends get 503 over_budget with Retry-After until UTC midnight; reads continue', async () => {
    const group = await freshGroup();
    const used = await counter();
    await withLimits({ daily_write_budget: used + 1 }, async () => {
      expect((await append(group, [envelope()])).status).toBe(200);
      const over = await append(group, [envelope()]);
      expect(over.status).toBe(503);
      expect(await body(over)).toMatchObject({ error: 'over_budget' });
      const retryAfter = Number(over.headers.get('Retry-After'));
      expect(retryAfter).toBeGreaterThanOrEqual(1);
      expect(retryAfter).toBeLessThanOrEqual(86_400);
      expect(over.headers.get('Cache-Control')).toBe('no-store');
      expect(await body(await read(group))).toMatchObject({ next: 1 });
    });
  });

  it('counts events stored, not appends: duplicates are free, and an append that does not fit stores nothing', async () => {
    const group = await freshGroup();
    const used = await counter();
    await withLimits({ daily_write_budget: used + 4 }, async () => {
      const [a, b, c] = [envelope(), envelope(), envelope()];
      // 2 new events (the in-request repeat of `a` is one event): the day's count goes up by 2, not 1.
      expect(await body(await append(group, [a, b, a]))).toMatchObject({
        accepted: 2,
        duplicates: 1,
      });
      expect(await counter()).toBe(used + 2);
      // 3 new events would pass the budget by 1: refused whole, nothing stored, nothing counted.
      const over = await append(group, [c, envelope(), envelope()]);
      expect(over.status).toBe(503);
      expect(await counter()).toBe(used + 2);
      expect(await body(await read(group))).toMatchObject({ next: 2 });
      // A duplicate alongside new events counts only the new ones: 2 more fills the day exactly.
      expect(await body(await append(group, [a, c, envelope()]))).toMatchObject({
        accepted: 2,
        duplicates: 1,
      });
      expect(await counter()).toBe(used + 4);
      // On a spent day, an append of duplicates only still succeeds, and writes no row at all.
      const before = await env.DB.prepare('SELECT COUNT(*) AS n FROM counters').first('n');
      expect(await body(await append(group, [a, b, c]))).toMatchObject({
        accepted: 0,
        duplicates: 3,
        seq: 4,
      });
      expect(await counter()).toBe(used + 4);
      expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM counters').first('n')).toBe(before);
      expect((await append(group, [envelope()])).status).toBe(503);
    });
  });

  it('the first counted append of a day is checked too: one append can carry more events than the budget', async () => {
    const group = await freshGroup();
    await withLimits({ daily_write_budget: 2 }, async () => {
      // A new day's row is inserted with the append's count; three events against a budget of two is refused.
      await env.DB.prepare('DELETE FROM counters WHERE day = ?').bind(today()).run();
      const over = await append(group, [envelope(), envelope(), envelope()]);
      expect(over.status).toBe(503);
      expect(await body(over)).toMatchObject({ error: 'over_budget' });
      expect(
        await env.DB.prepare('SELECT COUNT(*) AS n FROM counters WHERE day = ?')
          .bind(today())
          .first('n'),
      ).toBe(0);
      expect(await body(await append(group, [envelope(), envelope()]))).toMatchObject({
        accepted: 2,
      });
      expect(await counter()).toBe(2);
    });
  });

  it('is exact under concurrency: appends in flight at the boundary cannot overshoot it', async () => {
    const used = await counter();
    await withLimits({ daily_write_budget: used + 3 }, async () => {
      // Every request reads the counter before any of them writes it, so a check in application code alone passes
      // all eight; the counters_budget trigger refuses the increment inside each batch instead.
      const groups = await Promise.all(Array.from({ length: 8 }, () => freshGroup()));
      const responses = await Promise.all(groups.map((group) => append(group, [envelope()])));
      const statuses = responses.map((r) => r.status).sort();
      expect(statuses).toEqual([200, 200, 200, 503, 503, 503, 503, 503]);
      for (const response of responses.filter((r) => r.status === 503)) {
        expect(await body(response)).toMatchObject({ error: 'over_budget' });
        expect(Number(response.headers.get('Retry-After'))).toBeGreaterThanOrEqual(1);
      }
      expect(await counter()).toBe(used + 3);
      const stored = await Promise.all(
        groups.map(async (group) => (await body(await read(group))).epoch),
      );
      expect(stored.filter((epoch) => epoch !== null)).toHaveLength(3);
    });
  });

  it('the counters_budget triggers refuse a count past the budget, on insert and update, and fail closed without the row', async () => {
    const day = '1999-12-31';
    const add = (n: number): D1PreparedStatement =>
      env.DB.prepare(
        'INSERT INTO counters (day, writes) VALUES (?, ?) ON CONFLICT (day) DO UPDATE SET writes = writes + excluded.writes',
      ).bind(day, n);
    try {
      await withLimits({ daily_write_budget: 5 }, async () => {
        await expect(add(6).run()).rejects.toThrow(/over_budget/); // the day's first row, already past it
        await add(3).run();
        await add(2).run(); // exactly the budget
        await expect(add(1).run()).rejects.toThrow(/over_budget/);
      });
      await withLimits({ daily_write_budget: 0 }, async () => {
        await add(100).run(); // 0 means no budget
      });
      await env.DB.prepare("DELETE FROM limits WHERE key = 'daily_write_budget'").run();
      await expect(add(1).run()).rejects.toThrow(/over_budget/);
      await env.DB.prepare('DELETE FROM counters WHERE day = ?').bind(day).run();
      await expect(add(1).run()).rejects.toThrow(/over_budget/);
    } finally {
      await env.DB.prepare('DELETE FROM counters WHERE day = ?').bind(day).run();
      await seedLimits();
    }
  });
});

describe('blocklist', () => {
  it('410 group_blocked on every group route after authentication; a wrong token still gets 401', async () => {
    const group = await freshGroup();
    await append(group, [envelope()]);
    await env.DB.prepare('INSERT INTO blocked (group_id, blocked_at) VALUES (?, ?)')
      .bind(group.groupId, Date.now())
      .run();
    const routes: Array<[string, string, unknown]> = [
      ['GET', `/v1/groups/${group.groupId}/events`, undefined],
      ['POST', `/v1/groups/${group.groupId}/events`, { events: [envelope()] }],
      ['DELETE', `/v1/groups/${group.groupId}`, undefined],
      ['PUT', `/v1/groups/${group.groupId}/subscriptions`, {}],
    ];
    for (const [method, path, json] of routes) {
      const blocked = await call(method, path, { token: group.token, json });
      expect(blocked.status, `${method} ${path}`).toBe(410);
      expect(await body(blocked)).toMatchObject({ error: 'group_blocked' });
      expect((await call(method, path, { token: (await freshGroup()).token, json })).status).toBe(
        401,
      );
    }
  });
});

describe('rate limiting', () => {
  it('429 rate_limited with Retry-After when the request limiter says no, and the log line says limited', async () => {
    const group = await freshGroup();
    const limiter = fakeLimiter(false);
    for (const response of [
      await call('GET', '/v1/info', { env: { RATE_REQUESTS: limiter } }),
      await read(group, '', { env: { RATE_REQUESTS: limiter } }),
    ]) {
      expect(response.status).toBe(429);
      expect(response.headers.get('Retry-After')).toBe('60');
      expect(await body(response)).toMatchObject({ error: 'rate_limited' });
    }
    expect(requestLines().map((line) => line.limited)).toEqual([true, true]);
  });

  it('the request limiter runs before any D1 read: a refused request is 429, never a 500 from D1', async () => {
    const group = await freshGroup();
    const unreachable = {
      prepare: () => {
        throw new Error('D1 was read');
      },
      batch: () => Promise.reject(new Error('D1 was read')),
      exec: () => Promise.reject(new Error('D1 was read')),
    } as unknown as D1Database;
    const refused = { env: { DB: unreachable, RATE_REQUESTS: fakeLimiter(false) } };
    const responses = [
      await call('GET', '/v1/info', refused),
      await read(group, '', refused),
      await append(group, [envelope()], refused),
      await call('DELETE', `/v1/groups/${group.groupId}`, { token: group.token, ...refused }),
    ];
    expect(responses.map((r) => r.status)).toEqual([429, 429, 429, 429]);
    for (const response of responses)
      expect(await body(response)).toMatchObject({ error: 'rate_limited' });
    expect(lines.filter((line) => line.event === 'unhandled_exception')).toEqual([]);
    // The same stub behind an allowing limiter is reached, so the 429s above were decided before it.
    const allowed = { env: { DB: unreachable, RATE_REQUESTS: fakeLimiter(true) } };
    expect((await call('GET', '/v1/info', allowed)).status).toBe(500);
    expect((await read(group, '', allowed)).status).toBe(500);
  });

  it('a blocked group still counts against the request limiter, which answers first', async () => {
    const group = await freshGroup();
    await env.DB.prepare('INSERT INTO blocked (group_id, blocked_at) VALUES (?, ?)')
      .bind(group.groupId, Date.now())
      .run();
    const limiter = fakeLimiter((key) => key !== '198.51.100.9');
    const headers = { 'CF-Connecting-IP': '198.51.100.9' };
    expect((await read(group, '', { env: { RATE_REQUESTS: limiter }, headers })).status).toBe(429);
    expect((await read(group, '', { env: { RATE_REQUESTS: limiter } })).status).toBe(410);
    expect(limiter.keys).toHaveLength(2);
  });

  it('auth runs before any limiter: a wrong token never consumes one', async () => {
    const group = await freshGroup();
    const requests = fakeLimiter();
    const writes = fakeLimiter();
    const creates = fakeLimiter();
    const response = await append(
      { groupId: group.groupId, token: (await freshGroup()).token },
      [envelope()],
      {
        env: { RATE_REQUESTS: requests, RATE_WRITES: writes, RATE_CREATES: creates },
      },
    );
    expect(response.status).toBe(401);
    expect([requests.keys, writes.keys, creates.keys]).toEqual([[], [], []]);
  });

  it('the creation limiter is consulted only while the group has no row; the write limiter only on appends', async () => {
    const group = await freshGroup();
    const writes = fakeLimiter();
    const creates = fakeLimiter();
    const bindings = { env: { RATE_WRITES: writes, RATE_CREATES: creates } };
    await append(group, [envelope()], bindings);
    await append(group, [envelope()], bindings);
    await read(group, '', bindings);
    expect(writes.keys).toHaveLength(2);
    expect(creates.keys).toHaveLength(1);

    const refused = await append(await freshGroup(), [envelope()], {
      env: { RATE_CREATES: fakeLimiter(false) },
    });
    expect(refused.status).toBe(429);
  });

  it('the read limiter counts event reads only, before D1, alongside the request limiter', async () => {
    const group = await freshGroup();
    const reads = fakeLimiter();
    const requests = fakeLimiter();
    const bindings = { env: { RATE_READS: reads, RATE_REQUESTS: requests } };
    await append(group, [envelope()], bindings);
    await read(group, '?since=0', bindings);
    await read(group, '?since=1', bindings);
    await call('GET', '/v1/info', bindings);
    await call('DELETE', `/v1/groups/${group.groupId}`, { token: group.token, ...bindings });
    await call('PUT', `/v1/groups/${group.groupId}/subscriptions`, {
      token: group.token,
      json: {},
      ...bindings,
    });
    expect(reads.keys).toHaveLength(2);
    expect(requests.keys).toHaveLength(6);

    const unreachable = {
      prepare: () => {
        throw new Error('D1 was read');
      },
      batch: () => Promise.reject(new Error('D1 was read')),
    } as unknown as D1Database;
    const refused = await read(group, '', {
      env: { DB: unreachable, RATE_READS: fakeLimiter(false) },
    });
    expect(refused.status).toBe(429);
    expect(refused.headers.get('Retry-After')).toBe('60');
    expect(await body(refused)).toMatchObject({ error: 'rate_limited' });
    // Appends, deletes and /v1/info are not reads.
    const noReads = { env: { RATE_READS: fakeLimiter(false) } };
    expect((await append(group, [envelope()], noReads)).status).toBe(200);
    expect((await call('GET', '/v1/info', noReads)).status).toBe(200);
  });

  // A group of 600 events and pages of up to 500, as on the public server.
  const bigGroup = { max_group_events: 10_000, max_group_bytes: 100_000_000, max_page: 500 };

  it('an event read is charged one unit per started 100 D1 rows: a quiet poll 1, a full page 6', async () => {
    await withLimits({ ...bigGroup, reads_per_minute: 25 }, async () => {
      const group = await freshGroup();
      await fill(group, 600);
      const reads = fakeLimiter();
      const units = async (target: Group, query: string): Promise<number> => {
        const before = reads.keys.length;
        expect((await read(target, query, { env: { RATE_READS: reads } })).status).toBe(200);
        return reads.keys.length - before;
      };
      expect(await units(group, '?since=600')).toBe(1); // nothing new: 14 rows
      expect(await units(group, '?since=0')).toBe(6); // 500 events and more to come: 514 rows
      expect(await units(group, '?since=0&limit=86')).toBe(1); // 86 + the look-ahead row: 100 rows
      expect(await units(group, '?since=0&limit=87')).toBe(2); // 101 rows
      expect(await units(group, '?since=590')).toBe(1); // the last 10: 24 rows
      expect(await units(await freshGroup(), '')).toBe(1); // no group: 12 rows
    });
  });

  it('past the allowance a read is refused with 429 and Retry-After before its page is read, and the address stays refused', async () => {
    await withLimits({ ...bigGroup, reads_per_minute: 25 }, async () => {
      const group = await freshGroup();
      await fill(group, 600);
      const reads = allowanceLimiter(25);
      const batches: number[] = [];
      const db = {
        prepare: (query: string) => env.DB.prepare(query),
        batch: (statements: D1PreparedStatement[]) => {
          batches.push(statements.length);
          return env.DB.batch(statements);
        },
      } as unknown as D1Database;
      const bindings = { env: { DB: db, RATE_READS: reads } };
      for (let page = 0; page < 4; page++)
        expect((await read(group, '?since=0', bindings)).status).toBe(200);
      expect(reads.keys).toHaveLength(24);

      // A fifth full page: its first unit is the 25th, the next is refused, and the events are never read.
      batches.length = 0;
      const refused = await read(group, '?since=0', bindings);
      expect(refused.status).toBe(429);
      expect(refused.headers.get('Retry-After')).toBe('60');
      expect(await body(refused)).toMatchObject({ error: 'rate_limited' });
      expect(batches).toEqual([3]); // the prelude's batch only, not the page's
      expect(requestLines().at(-1)).toMatchObject({ status: 429, limited: true });

      // Out of units: even a quiet poll is refused, before any D1 read.
      batches.length = 0;
      expect((await read(group, '?since=600', bindings)).status).toBe(429);
      expect(batches).toEqual([]);

      // Another address has an allowance of its own.
      const elsewhere = { ...bindings, headers: { 'CF-Connecting-IP': '198.51.100.20' } };
      expect((await read(group, '?since=600', elsewhere)).status).toBe(200);
    });
  });

  it('a read is never charged more than the whole allowance, so a full page fits in a fresh minute', async () => {
    await withLimits({ ...bigGroup, reads_per_minute: 3 }, async () => {
      const group = await freshGroup();
      await fill(group, 600);
      const reads = allowanceLimiter(3);
      const page = await read(group, '?since=0', { env: { RATE_READS: reads } });
      expect(page.status).toBe(200);
      expect((await body<{ events: unknown[] }>(page)).events).toHaveLength(500);
      expect(reads.keys).toHaveLength(3);
      expect((await read(group, '?since=600', { env: { RATE_READS: reads } })).status).toBe(429);
    });
  });

  it('keys by CF-Connecting-IP, IPv6 by /64', async () => {
    const limiter = fakeLimiter();
    await call('GET', '/v1/info', {
      env: { RATE_REQUESTS: limiter },
      headers: { 'CF-Connecting-IP': '2001:db8:aa:bb:1:2:3:4' },
    });
    await call('GET', '/v1/info', {
      env: { RATE_REQUESTS: limiter },
      headers: { 'CF-Connecting-IP': '2001:db8:aa:bb::99' },
    });
    await call('GET', '/v1/info', {
      env: { RATE_REQUESTS: limiter },
      headers: { 'CF-Connecting-IP': '198.51.100.7' },
    });
    expect(limiter.keys).toEqual(['2001:db8:aa:bb::/64', '2001:db8:aa:bb::/64', '198.51.100.7']);
  });

  it('a missing binding allows the request and is logged once per isolate', async () => {
    const group = await freshGroup();
    const without = {
      env: {
        RATE_REQUESTS: undefined,
        RATE_WRITES: undefined,
        RATE_CREATES: undefined,
        RATE_READS: undefined,
      },
    };
    expect((await append(group, [envelope()], without)).status).toBe(200);
    expect((await append(group, [envelope()], without)).status).toBe(200);
    expect((await read(group, '', without)).status).toBe(200);
    const warnings = lines.filter((line) => line.event === 'ratelimit_binding_missing');
    expect(warnings.map((w) => w.binding).sort()).toEqual([
      'RATE_CREATES',
      'RATE_READS',
      'RATE_REQUESTS',
      'RATE_WRITES',
    ]);
  });

  it('a limiter that throws allows the request', async () => {
    const broken: RateLimit = {
      limit: () => Promise.reject(new Error('limiter unavailable')),
    };
    expect((await call('GET', '/v1/info', { env: { RATE_REQUESTS: broken } })).status).toBe(200);
  });
});

describe('logging', () => {
  it('one line per request with exactly method, route pattern, status, ms, limited — never the id, token, IP or query', async () => {
    const group: Group = await freshGroup();
    const ip = '203.0.113.77';
    const headers = { 'CF-Connecting-IP': ip };
    await append(group, [envelope()], { headers });
    await read(group, '?since=0&limit=5', { headers });
    await call('GET', `/v1/groups/${group.groupId}/nope`, { token: group.token, headers });
    await read({ groupId: group.groupId, token: (await freshGroup()).token }, '', { headers });

    expect(requestLines().map((l) => [l.method, l.route, l.status])).toEqual([
      ['POST', '/v1/groups/{groupId}/events', 200],
      ['GET', '/v1/groups/{groupId}/events', 200],
      ['GET', null, 404],
      ['GET', '/v1/groups/{groupId}/events', 401],
    ]);
    for (const line of requestLines()) {
      expect(Object.keys(line).sort()).toEqual(['limited', 'method', 'ms', 'route', 'status']);
      expect(typeof line.ms).toBe('number');
    }
    expect(lines).toHaveLength(4);
    const written = raw.join('\n');
    for (const secret of [group.groupId, group.token, ip, 'since', 'nope', 'even.test'])
      expect(written).not.toContain(secret);
  });

  it('an unhandled error is a 500 logged by exception type only', async () => {
    const group = await freshGroup();
    const failing = {
      prepare: () => {
        throw new TypeError(`boom ${group.groupId}`);
      },
    } as unknown as D1Database;
    const response = await read(group, '', { env: { DB: failing } });
    expect(response.status).toBe(500);
    expect(await body(response)).toEqual({ error: 'server_error' });
    expect(lines.find((line) => line.event === 'unhandled_exception')).toMatchObject({
      exception: 'TypeError',
      route: '/v1/groups/{groupId}/events',
    });
    expect(raw.join('\n')).not.toContain('boom');
    expect(raw.join('\n')).not.toContain(group.groupId);
  });
});

describe('HTTP surface', () => {
  it('Cache-Control: no-store and CORS on every response, including 204 and routing errors', async () => {
    const group = await freshGroup();
    const responses = [
      await call('GET', '/v1/info'),
      await call('GET', '/nope'),
      await call('POST', '/v1/info'),
      await call('DELETE', `/v1/groups/${group.groupId}`, { token: group.token }),
      await call('PUT', `/v1/groups/${group.groupId}/subscriptions`, {
        token: group.token,
        json: {},
      }),
    ];
    expect(responses.map((r) => r.status)).toEqual([200, 404, 405, 204, 501]);
    for (const response of responses) {
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    }
    expect(responses[2]?.headers.get('Allow')).toBe('GET');
    expect(await responses[3]?.text()).toBe('');
  });

  it('405 names the allowed methods; 405 is decided before the groupId is validated', async () => {
    const response = await call('GET', '/v1/groups/short');
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('DELETE');
    expect(await body(response)).toEqual({ error: 'method_not_allowed' });
  });

  it('answers a CORS preflight on known routes without authentication', async () => {
    const group = await freshGroup();
    const response = await call('OPTIONS', `/v1/groups/${group.groupId}/events`);
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET, POST');
    expect(response.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
    expect((await call('OPTIONS', '/nope')).status).toBe(404);
  });

  it('percent-decodes the groupId segment like a framework would', async () => {
    const group = await freshGroup();
    await append(group, [envelope()]);
    const encoded = group.groupId.replace(
      /^./,
      (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
    );
    const response = await call('GET', `/v1/groups/${encoded}/events`, { token: group.token });
    expect(await body(response)).toMatchObject({ next: 1 });
  });
});

describe('scheduled expiry', () => {
  const DAY = 86_400_000;

  async function runCron(scheduledTime: number): Promise<void> {
    await worker.scheduled(createScheduledController({ scheduledTime, cron: '17 3 * * *' }), env);
  }

  it('deletes groups idle for retention_days with their events, keeps the rest, and prunes old counters', async () => {
    const now = Date.now();
    const idle = await freshGroup();
    const active = await freshGroup();
    await append(idle, [envelope(), envelope()]);
    await append(active, [envelope()]);
    await env.DB.prepare('UPDATE groups SET last_write_at = ? WHERE id = ?')
      .bind(now - 366 * DAY, idle.groupId)
      .run();
    await env.DB.prepare(
      "INSERT OR REPLACE INTO counters (day, writes) VALUES ('2000-01-01', 5)",
    ).run();

    await runCron(now);

    expect(await body(await read(idle))).toEqual({ events: [], next: 0, more: false, epoch: null });
    expect(
      await env.DB.prepare('SELECT COUNT(*) AS n FROM events WHERE group_id = ?')
        .bind(idle.groupId)
        .first('n'),
    ).toBe(0);
    expect(await body(await read(active))).toMatchObject({ next: 1 });
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM counters WHERE day = '2000-01-01'").first(
        'n',
      ),
    ).toBe(0);
    expect(lines.find((line) => line.event === 'expiry')).toMatchObject({ retention_days: 365 });
  });

  it('uses the retention_days row, and deletes nothing when that row is missing', async () => {
    const now = Date.now();
    const group = await freshGroup();
    await append(group, [envelope()]);
    await env.DB.prepare('UPDATE groups SET last_write_at = ? WHERE id = ?')
      .bind(now - 3 * DAY, group.groupId)
      .run();
    try {
      await env.DB.prepare("DELETE FROM limits WHERE key = 'retention_days'").run();
      await runCron(now);
      expect(lines.find((line) => line.event === 'expiry_skipped')).toMatchObject({
        missing: ['retention_days'],
      });
    } finally {
      await seedLimits();
    }
    expect(await body(await read(group))).toMatchObject({ next: 1 });
    await withLimits({ retention_days: 2 }, async () => {
      await runCron(now);
      expect(await body(await read(group))).toMatchObject({ epoch: null });
    });
  });

  async function idleGroup(events: number, idleSinceMs: number): Promise<Group> {
    const group = await freshGroup();
    for (let i = 0; i < events; i += 25)
      await append(
        group,
        Array.from({ length: Math.min(25, events - i) }, () => envelope({ cipherBytes: 17 })),
      );
    await env.DB.prepare('UPDATE groups SET last_write_at = ? WHERE id = ?')
      .bind(idleSinceMs, group.groupId)
      .run();
    return group;
  }

  const storedEvents = async (group: Group): Promise<unknown> =>
    env.DB.prepare('SELECT COUNT(*) AS n FROM events WHERE group_id = ?')
      .bind(group.groupId)
      .first('n');

  it('deletes in bounded batches of whole groups, oldest first, and the next run carries on', async () => {
    const now = Date.now();
    await withLimits({ max_group_events: 200 }, async () => {
      // Oldest first: 3, 30, 1, 1, 50, 2 events. Leftovers from other tests are older still; clear them first.
      await expireIdleGroups(env, now);
      const sizes = [3, 30, 1, 1, 50, 2];
      const idle: Group[] = [];
      for (const [i, size] of sizes.entries())
        idle.push(await idleGroup(size, now - 400 * DAY + i));
      const active = await idleGroup(5, now);

      // Batches of at most 2 groups, taking a group while the events before it are fewer than 10: {3, 30} (3 events
      // come before the 30), then {1, 1}; then batchesPerRun stops the run.
      const first = await expireIdleGroups(env, now, {
        groupsPerBatch: 2,
        eventsPerBatch: 10,
        rowsPerRun: 100_000,
        batchesPerRun: 2,
      });
      expect(first).toMatchObject({ groups: 4, complete: false });
      expect(await Promise.all(idle.map(storedEvents))).toEqual([0, 0, 0, 0, 50, 2]);
      // The 50-event group is over the event bound, so its batch holds it alone, whole; then the run stops.
      const second = await expireIdleGroups(env, now, {
        groupsPerBatch: 5,
        eventsPerBatch: 10,
        rowsPerRun: 100_000,
        batchesPerRun: 1,
      });
      expect(second).toMatchObject({ groups: 1, complete: false });
      expect(await Promise.all(idle.map(storedEvents))).toEqual([0, 0, 0, 0, 0, 2]);
      const third = await expireIdleGroups(env, now);
      expect(third).toMatchObject({ groups: 1, complete: true });
      for (const group of idle) expect((await body(await read(group))).epoch).toBeNull();
      expect(await storedEvents(active)).toBe(5);
      expect(lines.filter((line) => line.event === 'expiry').at(-1)).toMatchObject({
        groups_deleted: 1,
        complete: true,
        retention_days: 365,
      });
    });
  });

  it('stops starting batches once a run has written rowsPerRun rows', async () => {
    const now = Date.now();
    await expireIdleGroups(env, now);
    const idle = [await idleGroup(20, now - 400 * DAY), await idleGroup(20, now - 400 * DAY + 1)];
    const run = await expireIdleGroups(env, now, {
      groupsPerBatch: 1,
      eventsPerBatch: 1_000,
      rowsPerRun: 10,
      batchesPerRun: 20,
    });
    expect(run).toMatchObject({ groups: 1, complete: false });
    expect(run?.rowsWritten).toBeGreaterThanOrEqual(21); // the group's 20 events and its row, at least
    expect(await Promise.all(idle.map(storedEvents))).toEqual([0, 20]);
    expect(await expireIdleGroups(env, now)).toMatchObject({ groups: 1, complete: true });
  });

  it('finds idle groups through the last_write_at index, without reading the active ones', async () => {
    const now = Date.now();
    await expireIdleGroups(env, now);
    for (let i = 0; i < 30; i++) await idleGroup(1, now);
    await idleGroup(1, now - 400 * DAY);
    const pick = await env.DB.prepare(
      'SELECT id FROM groups WHERE last_write_at < ? ORDER BY last_write_at, rowid LIMIT ?',
    )
      .bind(now - 365 * DAY, 100)
      .all();
    expect(pick.results).toHaveLength(1);
    expect(pick.meta.rows_read).toBeLessThan(5);
    expect(await expireIdleGroups(env, now)).toMatchObject({ groups: 1, complete: true });
  });
});

describe('D1 rows read by an event read (the read allowance is counted in these; README.md)', () => {
  it('readRows predicts meta.rows_read before the page is read: 14 for a quiet poll, 514 for a full page, never too few', async () => {
    await withLimits(
      { max_group_events: 10_000, max_group_bytes: 100_000_000, max_page: 500 },
      async () => {
        const group = await freshGroup();
        await fill(group, 600);
        const missing = await freshGroup();
        // group, since, limit, rows: 12 in the prelude, 1 for the epoch, then the events and one more row. Where the
        // scan runs out of the group's events, the extra row is the next group's first index entry, which a group
        // last in the index does not have; there D1 counts one fewer, never more.
        const cases: Array<[Group, number, number, number, 'exact' | 'at most']> = [
          [group, 600, 500, 14, 'exact'], // nothing new: the probe that finds nothing reads 1
          [group, 0, 500, 514, 'exact'], // 500 events and the look-ahead row
          [group, 0, 86, 100, 'exact'],
          [group, 0, 87, 101, 'exact'],
          [group, 5_000, 500, 14, 'exact'], // a cursor past the log (an older epoch's)
          [missing, 0, 500, 12, 'exact'], // no row: 11 limits rows, no epoch, the probe
          [group, 100, 500, 514, 'at most'], // exactly 500 left: the scan runs out
          [group, 590, 500, 24, 'at most'], // the last 10
        ];
        for (const [target, since, limit, rows, how] of cases) {
          const state = await store.groupState(env.DB, target.groupId);
          const page = await store.read(env.DB, target.groupId, since, limit);
          const measured = state.rowsRead + page.rowsRead;
          expect(store.readRows(state, since, limit), `predicted, since ${since} limit ${limit}`).toBe(rows);
          if (how === 'exact') expect(measured, `measured, since ${since} limit ${limit}`).toBe(rows);
          else expect([rows - 1, rows], `measured, since ${since} limit ${limit}`).toContain(measured);
        }
        expect([14, 514, 100, 101, 12].map(readUnits)).toEqual([1, 6, 1, 2, 1]);
      },
    );
  });
});

describe('D1 rows written by an append (the daily write budget is sized on these; README.md)', () => {
  const limitsForAppend = { max_batch: 25, max_event_bytes: 8192 };
  async function stored(
    groupId: string,
    events: ReturnType<typeof envelope>[],
    day: string,
    nowMs: number,
  ): Promise<store.AppendResult> {
    const parsed = parseAppendBody({ events }, limitsForAppend);
    return store.append(env.DB, groupId, parsed, { epoch: 'E'.repeat(22), nowMs, day });
  }

  it('4 per new event; 3 for a new group, 2 for an existing group, 1 for the counter (2 on its first row); 0 for duplicates', async () => {
    const day = '2040-01-01';
    try {
      await withLimits({ max_group_events: 10_000, max_group_bytes: 10_000_000 }, async () => {
        const group = await freshGroup();
        const first = [envelope({ cipherBytes: 17 })];
        // The day's first counted append, creating its group: 2 + 3 + 4.
        expect((await stored(group.groupId, first, day, 1_000)).rowsWritten).toBe(9);
        // One new event to an existing group, later: 1 + 2 (last_write_at and its index entry) + 4.
        expect((await stored(group.groupId, [envelope()], day, 2_000)).rowsWritten).toBe(7);
        // A full batch to an existing group: 1 + 2 + 25 × 4.
        const full = Array.from({ length: 25 }, () => envelope({ cipherBytes: 17 }));
        expect((await stored(group.groupId, full, day, 3_000)).rowsWritten).toBe(103);
        // Duplicates only: nothing at all, the counter included.
        expect((await stored(group.groupId, full, day, 4_000)).rowsWritten).toBe(0);
        // One new event to a new group, not the day's first: 1 + 3 + 4, the worst case per event.
        const other = await freshGroup();
        expect((await stored(other.groupId, [envelope()], day, 5_000)).rowsWritten).toBe(8);
        // last_write_at moved once per append, and never backwards: an append whose clock is behind arrives 1 ms
        // after the one before (received_at, design.md "Append").
        await stored(group.groupId, [envelope()], day, 2_500);
        expect(
          await env.DB.prepare('SELECT last_write_at FROM groups WHERE id = ?')
            .bind(group.groupId)
            .first('last_write_at'),
        ).toBe(3_001);
      });
    } finally {
      await env.DB.prepare('DELETE FROM counters WHERE day = ?').bind(day).run();
    }
  });
});
