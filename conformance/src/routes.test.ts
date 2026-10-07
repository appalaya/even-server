/** PROTOCOL.md §7 routing errors (404, 405) and §5: Cache-Control: no-store and JSON on every response. */
import { describe, expect, it } from 'vitest';
import { responseProblems, type Reply } from './client.ts';
import { client, expectError, expectStatus, info, TestGroup } from './harness.ts';
import { malformed } from './keys.ts';

describe('§7 routing', () => {
  // Not `/` or `/robots.txt`: they are outside the protocol, and a server may answer them (PROTOCOL.md §7).
  const unknown: Array<[method: string, path: (id: string) => string]> = [
    ['GET', () => '/v1'],
    ['GET', () => '/v1/nope'],
    ['GET', () => '/v2/info'],
    ['GET', () => '/v1/info/'],
    ['GET', () => '/v1/groups'],
    ['GET', (id) => `/v1/groups/${id}/nope`],
    ['POST', (id) => `/v1/groups/${id}/events/extra`],
  ];

  it.each(unknown)('unknown route %s %s → 404 not_found (not a redirect)', async (method, path) => {
    const group = TestGroup.fresh();
    expectError(await client().request(method, path(group.groupId), { bearer: group.token }), 404, 'not_found');
  });

  const wrongMethod: Array<[method: string, path: (id: string) => string]> = [
    ['POST', () => '/v1/info'],
    ['PUT', () => '/v1/info'],
    ['DELETE', () => '/v1/info'],
    ['PUT', (id) => `/v1/groups/${id}/events`],
    ['DELETE', (id) => `/v1/groups/${id}/events`],
    ['PATCH', (id) => `/v1/groups/${id}/events`],
    ['GET', (id) => `/v1/groups/${id}`],
    ['POST', (id) => `/v1/groups/${id}`],
    ['PUT', (id) => `/v1/groups/${id}`],
    ['GET', (id) => `/v1/groups/${id}/subscriptions`],
    ['POST', (id) => `/v1/groups/${id}/subscriptions`],
    ['DELETE', (id) => `/v1/groups/${id}/subscriptions`],
  ];

  it.each(wrongMethod)('known route, wrong method: %s %s → 405 method_not_allowed', async (method, path) => {
    const group = TestGroup.fresh();
    const body = method === 'GET' || method === 'DELETE' ? {} : { json: {} };
    expectError(await client().request(method, path(group.groupId), { bearer: group.token, ...body }), 405, 'method_not_allowed');
  });
});

describe('§5 every response carries Cache-Control: no-store and a JSON content type', () => {
  // The setup file checks every response of every test; this test names one of each status explicitly.
  it('200, 204, 400, 401, 404, 405, 415 and (when push is false) 501', async () => {
    const group = TestGroup.fresh();
    const replies: Array<[string, Reply]> = [];
    const take = async (label: string, status: number, reply: Promise<Reply>): Promise<void> => {
      const r = await reply;
      expectStatus(r, status);
      replies.push([label, r]);
    };
    await take('info', 200, client().info());
    await take('append', 200, group.append([group.envelope()]));
    await take('read', 200, group.read());
    await take('read of a missing group', 200, TestGroup.fresh().read());
    await take('limit=0', 400, group.read({ limit: 0 }));
    await take('invalid_envelope', 400, group.append([malformed.without(group.envelope(), 'c')]));
    await take('malformed groupId', 400, client().read(group.groupId.slice(1), group.token));
    await take('no token', 401, client().read(group.groupId, undefined));
    await take('unknown route', 404, client().request('GET', '/v1/nope'));
    await take('wrong method', 405, client().request('POST', '/v1/info', { json: {} }));
    await take('unsupported_version', 415, group.append([group.envelope({ v: 2 })]));
    if (!info().push) await take('subscriptions', 501, group.subscribe());
    await take('delete', 204, group.delete());

    for (const [label, reply] of replies) expect(responseProblems(reply), label).toEqual([]);
  });
});
