/** PROTOCOL.md §6.4 DELETE /v1/groups/{groupId}, and §6.6 epochs across deletion. */
import { describe, expect, it } from 'vitest';
import { client, expectEpoch, expectError, expectMissingGroup, expectStatus, TestGroup, unsequenced } from './harness.ts';

describe('§6.4 delete', () => {
  it('→ 204; the group then reads as missing; the next write recreates it with seq 1 and a different epoch', async () => {
    const group = TestGroup.fresh();
    const before = await group.appendOk(group.envelopes(3));
    expectStatus(await group.delete(), 204);

    expectMissingGroup(await group.readOk());

    const fresh = group.envelope();
    const after = await group.appendOk([fresh]);
    expect(after).toMatchObject({ accepted: 1, duplicates: 0, seq: 1 });
    expectEpoch(after.epoch, 'after recreation');
    expect(after.epoch).not.toBe(before.epoch);

    const page = await group.readOk();
    expect(page.events.map(unsequenced)).toEqual([fresh]);
    expect(page.events.map((e) => e.seq)).toEqual([1]);
    expect(page.epoch).toBe(after.epoch);
  });

  it('forgets stored ids: re-pushing the old envelopes after a delete is accepted, not counted as duplicates (§10 self-heal)', async () => {
    const group = TestGroup.fresh();
    const log = group.envelopes(4);
    const first = await group.appendOk(log);
    expectStatus(await group.delete(), 204);
    const again = await group.appendOk(log);
    expect(again).toMatchObject({ accepted: 4, duplicates: 0, seq: 4 });
    expect(again.epoch).not.toBe(first.epoch);
    expect((await group.readOk()).events.map(unsequenced)).toEqual(log);
  });

  it('gives every incarnation a new epoch (§6.6: never reused)', async () => {
    const group = TestGroup.fresh();
    const epochs = new Set<string>();
    for (let i = 0; i < 3; i++) {
      epochs.add((await group.appendOk([group.envelope()])).epoch);
      expectStatus(await group.delete(), 204);
    }
    expect(epochs.size).toBe(3);
  });

  it('of a group that does not exist → 204 (idempotent)', async () => {
    const group = TestGroup.fresh();
    expectStatus(await group.delete(), 204);
    expectStatus(await group.delete(), 204);
    expectMissingGroup(await group.readOk());
  });

  it('twice in a row → 204 both times', async () => {
    const group = TestGroup.fresh();
    await group.appendOk([group.envelope()]);
    expectStatus(await group.delete(), 204);
    expectStatus(await group.delete(), 204);
  });

  it('with a wrong token → 401 and the group survives', async () => {
    const group = TestGroup.fresh();
    const stored = group.envelope();
    const { epoch } = await group.appendOk([stored]);
    expectError(await client().deleteGroup(group.groupId, TestGroup.fresh().token), 401, 'unauthorized');
    expectError(await client().deleteGroup(group.groupId, undefined), 401, 'unauthorized');
    const page = await group.readOk();
    expect(page.events.map(unsequenced)).toEqual([stored]);
    expect(page.epoch).toBe(epoch);
  });
});
