/** PROTOCOL.md §6.5 PUT /v1/groups/{groupId}/subscriptions: authenticate as usual, then 501 when push is false. */
import { describe, it } from 'vitest';
import { client, expectError, info, TestGroup } from './harness.ts';

describe('§6.5 subscriptions (reserved)', () => {
  it('no token → 401 unauthorized, before any 501', async () => {
    const group = TestGroup.fresh();
    expectError(await client().subscribe(group.groupId, undefined), 401, 'unauthorized');
  });

  it('a wrong token → 401 unauthorized, before any 501', async () => {
    const group = TestGroup.fresh();
    expectError(await client().subscribe(group.groupId, TestGroup.fresh().token), 401, 'unauthorized');
  });

  it.skipIf(info().push)('the right token → 501 not_implemented, since /v1/info says push: false', async () => {
    const group = TestGroup.fresh();
    expectError(await group.subscribe({}), 501, 'not_implemented');
  });

  it.skipIf(info().push)('the right token on an existing group → 501 not_implemented', async () => {
    const group = TestGroup.fresh();
    await group.appendOk([group.envelope()]);
    expectError(await group.subscribe({ token: 'x' }), 501, 'not_implemented');
  });
});
