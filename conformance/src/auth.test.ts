/**
 * PROTOCOL.md §2 and §7: malformed groupId in the path → 400; missing, malformed or mismatched bearer token → 401.
 * Auth is stateless: the server recomputes base64url(SHA-256(token)) and compares it with the path.
 */
import { describe, expect, it } from 'vitest';
import type { Reply, RequestOptions } from './client.ts';
import { client, expectError, TestGroup, unsequenced } from './harness.ts';
import { b64urlEncode, deriveServer, malformed, randomBytes } from './keys.ts';

type Route = [name: string, call: (groupId: string, auth: RequestOptions, group: TestGroup) => Promise<Reply>];

/** Every group-scoped route (§6.2–§6.5). */
const ROUTES: Route[] = [
  ['GET events', (id, auth) => client().request('GET', `/v1/groups/${id}/events`, auth)],
  ['POST events', (id, auth, g) => client().request('POST', `/v1/groups/${id}/events`, { ...auth, json: { events: [g.envelope()] } })],
  ['DELETE group', (id, auth) => client().request('DELETE', `/v1/groups/${id}`, auth)],
  ['PUT subscriptions', (id, auth) => client().request('PUT', `/v1/groups/${id}/subscriptions`, { ...auth, json: {} })],
];

const wellFormedToken = (): string => b64urlEncode(randomBytes(32));

/** A group with one stored event, so that 401s can also be checked for side effects. */
async function populated(): Promise<{ group: TestGroup; stored: ReturnType<TestGroup['envelope']>; epoch: string }> {
  const group = TestGroup.fresh();
  const stored = group.envelope();
  const { epoch } = await group.appendOk([stored]);
  return { group, stored, epoch };
}

/** The group still holds exactly its one event under the same epoch: the rejected requests changed nothing. */
async function expectUntouched(group: TestGroup, stored: ReturnType<TestGroup['envelope']>, epoch: string): Promise<void> {
  const page = await group.readOk();
  expect(page.events.map(unsequenced)).toEqual([stored]);
  expect(page.epoch).toBe(epoch);
}

describe('§7 malformed groupId in the path → 400 invalid_request', () => {
  const valid = (): string => TestGroup.fresh().groupId;
  it.each<[string, () => string]>([
    ['42 characters', () => valid().slice(0, 42)],
    ['44 characters', () => `${valid()}A`],
    ['a "+" (standard base64 alphabet)', () => malformed.withChar(valid(), 10, '+')],
    ['"=" padding', () => malformed.withChar(valid(), -1, '=')],
    ['a "~"', () => malformed.withChar(valid(), 0, '~')],
  ])('%s, on every group route (even with a well-formed bearer token)', async (_label, makeId) => {
    const group = TestGroup.fresh();
    for (const [name, call] of ROUTES) {
      const reply = await call(makeId(), { bearer: wellFormedToken() }, group);
      expect(reply.status, `${name}: ${reply.status} ${reply.text}`).toBe(400);
      expectError(reply, 400, 'invalid_request');
    }
  });
});

describe('§7 bearer token problems → 401 unauthorized, with no side effects', () => {
  it('no Authorization header, on every group route', async () => {
    const { group, stored, epoch } = await populated();
    for (const [, call] of ROUTES) expectError(await call(group.groupId, {}, group), 401, 'unauthorized');
    await expectUntouched(group, stored, epoch);
  });

  it.each<[string, (token: string) => string]>([
    ['a 42-character token', (t) => `Bearer ${t.slice(0, 42)}`],
    ['a 44-character token', (t) => `Bearer ${t}A`],
    ['a token with "+"', (t) => `Bearer ${malformed.withChar(t, 3, '+')}`],
    ['a token with "=" padding', (t) => `Bearer ${t}=`],
    ['an empty Bearer credential', () => 'Bearer '],
    ['the right token under the Basic scheme', (t) => `Basic ${t}`],
    ['the right token with no scheme', (t) => t],
  ])('%s, on every group route', async (_label, header) => {
    const { group, stored, epoch } = await populated();
    for (const [, call] of ROUTES) {
      expectError(await call(group.groupId, { authorization: header(group.token) }, group), 401, 'unauthorized');
    }
    await expectUntouched(group, stored, epoch);
  });

  it('a well-formed token that belongs to a different group, on every group route', async () => {
    const { group, stored, epoch } = await populated();
    const other = TestGroup.fresh();
    for (const [, call] of ROUTES) expectError(await call(group.groupId, { bearer: other.token }, group), 401, 'unauthorized');
    await expectUntouched(group, stored, epoch);
  });

  it('the same secret’s token for a different server origin (§2: tokens are per server)', async () => {
    const { group, stored, epoch } = await populated();
    const elsewhere = deriveServer(group.secret, 'https://another-server.example').token;
    expect(elsewhere).not.toBe(group.token);
    for (const [, call] of ROUTES) expectError(await call(group.groupId, { bearer: elsewhere }, group), 401, 'unauthorized');
    await expectUntouched(group, stored, epoch);
  });

  it('a wrong token gets the same 401 whether or not the group exists (§6.3: existence is not observable)', async () => {
    const { group: existing } = await populated();
    const missing = TestGroup.fresh();
    const intruder = TestGroup.fresh().token;
    const a = await client().read(existing.groupId, intruder);
    const b = await client().read(missing.groupId, intruder);
    expectError(a, 401, 'unauthorized');
    expectError(b, 401, 'unauthorized');
    expect(a.json, 'the 401 body must not differ between an existing and a missing group').toEqual(b.json);
  });

  it('the right token is accepted on a group that does not exist yet (auth needs no stored state)', async () => {
    const group = TestGroup.fresh();
    expect((await group.readOk()).epoch).toBeNull();
    expect(await group.appendOk([group.envelope()])).toMatchObject({ accepted: 1, seq: 1 });
  });
});
