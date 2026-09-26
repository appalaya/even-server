/**
 * PROTOCOL.md §7/§9 blocking: a blocked group id answers 410 group_blocked on every group route.
 *
 * Opt-in, because only the operator can block an id. The suite authenticates as a fixed, public conformance secret;
 * `npm run blocked-id` prints the group id it derives for EVEN_SERVER_URL. Block that id on the server, then run with
 * EVEN_CONFORMANCE_BLOCKED_GROUP_ID=<that id>. A valid token is used so that the test does not depend on whether a
 * server checks the block before or after authentication.
 */
import { describe, expect, it } from 'vitest';
import type { Reply } from './client.ts';
import { options } from './env.ts';
import { client, expectError, TestGroup } from './harness.ts';
import { blockedGroupSecret } from './keys.ts';

const blockedId = options.blockedGroupId();

describe.skipIf(blockedId === undefined)('§9 a blocked group id (EVEN_CONFORMANCE_BLOCKED_GROUP_ID)', () => {
  const group = (): TestGroup => TestGroup.fromSecret(blockedGroupSecret());

  it('is the conformance suite’s blocked group for this server', () => {
    const expected = group().groupId;
    expect(blockedId, `EVEN_CONFORMANCE_BLOCKED_GROUP_ID must be ${expected} (npm run blocked-id), and that id must be blocked on the server`).toBe(expected);
  });

  it.each<[string, (g: TestGroup) => Promise<Reply>]>([
    ['GET events', (g) => g.read()],
    ['POST events', (g) => g.append([g.envelope()])],
    ['DELETE group', (g) => g.delete()],
    ['PUT subscriptions', (g) => client().subscribe(g.groupId, g.token, {})],
  ])('%s with the right token → 410 group_blocked', async (_label, call) => {
    expectError(await call(group()), 410, 'group_blocked');
  });
});
