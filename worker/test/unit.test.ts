/** Pure functions: base64url, bearer parsing, envelope validation, IP keys, limits, routing. */
import { describe, expect, it } from 'vitest';
import { groupIdFor, isGroupId, parseBearer } from '../src/auth';
import { decode, decodedLength, encode, isB64url } from '../src/b64';
import { firstOccurrences, parseAppendBody } from '../src/envelope';
import { ApiError } from '../src/http';
import {
  driftFromVars,
  infoDocument,
  limitsFromRows,
  LimitsMissing,
  maxBodyBytes,
} from '../src/limits';
import { ipKey } from '../src/ratelimit';
import { matchRoute } from '../src/routes';
import { LIMIT_VARIABLES } from '../src/vars';
import { envelope, randomB64, TEST_LIMITS } from './helpers';

describe('base64url', () => {
  it('accepts only the unpadded url-safe alphabet', () => {
    expect(isB64url('AZaz09-_')).toBe(true);
    expect(isB64url('AZaz09-_', 8)).toBe(true);
    expect(isB64url('AZaz09-_', 9)).toBe(false);
    for (const bad of ['a+b', 'a/b', 'ab==', 'a b', 'a\nb', 'ä'])
      expect(isB64url(bad), bad).toBe(false);
    expect(isB64url(42)).toBe(false);
  });

  it('computes decoded length without decoding, rejecting 4k + 1 lengths', () => {
    expect(decodedLength('')).toBe(0);
    expect(decodedLength('AA')).toBe(1);
    expect(decodedLength('AAA')).toBe(2);
    expect(decodedLength('AAAA')).toBe(3);
    expect(decodedLength('AAAAA')).toBeUndefined();
    expect(decodedLength('AA==')).toBeUndefined();
  });

  it('round-trips bytes', () => {
    const bytes = crypto.getRandomValues(new Uint8Array(33));
    expect(decode(encode(bytes))).toEqual(bytes);
    expect(encode(new Uint8Array([251, 255]))).toBe('-_8');
  });
});

describe('auth', () => {
  it('parses Bearer case-insensitively and requires exactly 43 base64url characters', () => {
    const token = randomB64(32);
    expect(parseBearer(`Bearer ${token}`)).toEqual(decode(token));
    expect(parseBearer(`bearer ${token}`)).toEqual(decode(token));
    expect(parseBearer(`  Bearer   ${token}  `)).toEqual(decode(token));
    for (const bad of [
      null,
      '',
      'Bearer',
      'Bearer ',
      token,
      `Basic ${token}`,
      `Bearer ${token}=`,
      `Bearer ${token.slice(1)}`,
      `Bearer ${token}A`,
    ]) {
      expect(parseBearer(bad), String(bad)).toBeUndefined();
    }
  });

  it('derives the group id as base64url(SHA-256(token)) (PROTOCOL.md §2)', async () => {
    // SHA-256 of 32 zero bytes.
    expect(await groupIdFor(new Uint8Array(32))).toBe(
      'Zmh6rfhivXdsj8GLjp-OIAiXFIVu4jOzkCpZHQ1fKSU',
    );
    expect(isGroupId('Zmh6rfhivXdsj8GLjp-OIAiXFIVu4jOzkCpZHQ1fKSU')).toBe(true);
    expect(isGroupId('Zmh6rfhivXdsj8GLjp-OIAiXFIVu4jOzkCpZHQ1fKS')).toBe(false);
  });
});

describe('envelope validation (§4, §6.2)', () => {
  const limits = { max_batch: 5, max_event_bytes: 300 };
  const rejects = (document: unknown): ApiError => {
    try {
      parseAppendBody(document, limits);
    } catch (error) {
      if (error instanceof ApiError) return error;
      throw error;
    }
    throw new Error('expected a rejection');
  };

  it('checks the request shape first', () => {
    for (const body of [null, [], 'x', {}, { events: {} }, { events: [] }]) {
      expect(rejects(body)).toMatchObject({ status: 400, error: 'invalid_request' });
    }
    const tooMany = Array.from({ length: 6 }, () => ({}));
    expect(rejects({ events: tooMany })).toMatchObject({ status: 400, error: 'invalid_request' });
  });

  it('computes stored size as decoded c + 64 and keeps request order', () => {
    const a = envelope({ cipherBytes: 17 });
    const b = envelope({ cipherBytes: 100 });
    expect(parseAppendBody({ events: [a, b] }, limits).map((e) => [e.id, e.size])).toEqual([
      [a.id, 81],
      [b.id, 164],
    ]);
  });

  it('v must be a positive integer: 1.0 is 1; 0, -1, 1.5, "1", true, null are structural', () => {
    const text = JSON.stringify({ events: [envelope()] }).replace('"v":1', '"v":1.0');
    expect(text).toContain('"v":1.0');
    expect(parseAppendBody(JSON.parse(text), limits)[0]?.v).toBe(1);
    for (const v of [0, -1, 1.5, '1', true, null]) {
      expect(rejects({ events: [envelope(), envelope({ v })] }), String(v)).toMatchObject({
        status: 400,
        error: 'invalid_envelope',
        index: 1,
      });
    }
    expect(rejects({ events: [envelope(), envelope({ v: 2 })] })).toMatchObject({
      status: 415,
      error: 'unsupported_version',
      index: 1,
    });
  });

  it('a structural error anywhere wins over an unsupported version earlier in the batch', () => {
    expect(
      rejects({ events: [envelope({ v: 2 }), envelope(), { ...envelope(), x: 1 }] }),
    ).toMatchObject({ status: 400, index: 2 });
  });

  it('rejects extra, missing and malformed fields, and c outside 17..max_event_bytes', () => {
    const cases: unknown[] = [
      null,
      [],
      { ...envelope(), x: 1 },
      JSON.parse(JSON.stringify(envelope()).replace('{', '{"__proto__":1,')), // an own "__proto__" key is an extra field
      { id: randomB64(16), v: 1, n: randomB64(24) },
      envelope({ id: randomB64(15) }),
      envelope({ id: `${randomB64(16).slice(0, 21)}+` }),
      envelope({ n: randomB64(23) }),
      envelope({ cipherBytes: 16 }),
      envelope({ cipherBytes: 301 }),
      { ...envelope(), c: `${randomB64(30)}=` },
      { ...envelope(), c: 'AAAAA' },
    ];
    for (const [i, bad] of cases.entries()) {
      expect(rejects({ events: [bad] }), `case ${i}`).toMatchObject({
        status: 400,
        error: 'invalid_envelope',
        index: 0,
      });
    }
    expect(
      parseAppendBody(
        { events: [envelope({ cipherBytes: 17 }), envelope({ cipherBytes: 300 })] },
        limits,
      ),
    ).toHaveLength(2);
  });

  it('collapses ids repeated within a request to their first occurrence', () => {
    const a = envelope();
    const aAgain = envelope({ id: a.id });
    const b = envelope();
    const parsed = parseAppendBody({ events: [a, aAgain, b, a] }, limits);
    expect(firstOccurrences(parsed).map((e) => [e.id, e.c])).toEqual([
      [a.id, a.c],
      [b.id, b.c],
    ]);
  });
});

describe('ipKey (rate-limit keys)', () => {
  it.each([
    ['203.0.113.9', '203.0.113.9'],
    ['2001:db8:1:2:3:4:5:6', '2001:db8:1:2::/64'],
    ['2001:0DB8:0001:0002::1', '2001:db8:1:2::/64'],
    ['2001:db8::1', '2001:db8:0:0::/64'],
    ['::1', '0:0:0:0::/64'],
    ['fe80::1%eth0', 'fe80:0:0:0::/64'],
    ['::ffff:198.51.100.7', '198.51.100.7'],
    ['2001:db8:1:2::203.0.113.1', '2001:db8:1:2::/64'],
    ['not an ip:::', 'not an ip:::'],
    ['1:2:3:4:5:6:7:8:9', '1:2:3:4:5:6:7:8:9'],
  ])('%s → %s', (address, key) => {
    expect(ipKey(address)).toBe(key);
  });
});

describe('limits', () => {
  const rows = Object.entries(TEST_LIMITS).map(([key, value]) => ({ key, value }));

  it('reads every published limit from the table rows', () => {
    expect(limitsFromRows(rows)).toEqual(TEST_LIMITS);
    expect(LIMIT_VARIABLES.map((l) => l.key).sort()).toEqual(Object.keys(TEST_LIMITS).sort());
  });

  it('fails closed when a row is missing or not an integer', () => {
    expect(() => limitsFromRows(rows.filter((r) => r.key !== 'max_page'))).toThrow(LimitsMissing);
    try {
      limitsFromRows([
        ...rows.filter((r) => r.key !== 'max_batch'),
        { key: 'max_batch', value: '25' },
      ]);
    } catch (error) {
      expect((error as LimitsMissing).missing).toEqual(['max_batch']);
    }
  });

  it('builds /v1/info from the limits, with operator and terms only when set', () => {
    const doc = infoDocument(TEST_LIMITS, '', undefined);
    expect(doc).toEqual({
      protocol: [1],
      limits: {
        max_event_bytes: 8192,
        max_group_bytes: 65536,
        max_group_events: 200,
        max_batch: 25,
        max_page: 50,
        daily_write_budget: 0,
        rate: {
          requests_per_minute: 100000,
          writes_per_minute: 100000,
          group_creates_per_minute: 100000,
        },
      },
      retention_days: 365,
      push: false,
    });
    expect(infoDocument(TEST_LIMITS, 'Even', 'https://example.net/terms')).toMatchObject({
      operator: 'Even',
      terms: 'https://example.net/terms',
    });
  });

  it('bounds the append body no tighter than a full batch of maximum-size envelopes', () => {
    const full = TEST_LIMITS.max_batch * (4 * Math.ceil(TEST_LIMITS.max_event_bytes / 3) + 200);
    expect(maxBodyBytes(TEST_LIMITS)).toBeGreaterThan(full);
  });

  it('reports table rows that differ from the deployment vars', () => {
    expect(
      driftFromVars(TEST_LIMITS, { EVEN_MAX_PAGE: '50', EVEN_MAX_BATCH: '25', EVEN_OPERATOR: 'x' }),
    ).toEqual([]);
    expect(
      driftFromVars(TEST_LIMITS, { EVEN_MAX_PAGE: '500', EVEN_DAILY_WRITE_BUDGET: '' }),
    ).toEqual(['max_page']);
  });
});

describe('matchRoute', () => {
  const id = 'Zmh6rfhivXdsj8GLjp-OIAiXFIVu4jOzkCpZHQ1fKSU';
  it.each([
    ['/v1/info', '/v1/info'],
    [`/v1/groups/${id}`, '/v1/groups/{groupId}'],
    [`/v1/groups/${id}/events`, '/v1/groups/{groupId}/events'],
    [`/v1/groups/${id}/subscriptions`, '/v1/groups/{groupId}/subscriptions'],
    ['/v1/groups/short/events', '/v1/groups/{groupId}/events'],
  ])('%s → %s', (path, pattern) => {
    expect(matchRoute(path)?.pattern).toBe(pattern);
  });

  it.each([
    '/',
    '/v1',
    '/v1/info/',
    '/v2/info',
    '/v1/groups',
    '/v1/groups/',
    `/v1/groups/${id}/`,
    `/v1/groups/${id}/events/`,
    `/v1/groups/${id}/nope`,
    '/v1/groups//events',
  ])('%s → unknown', (path) => {
    expect(matchRoute(path)).toBeUndefined();
  });
});
