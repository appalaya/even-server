/** PROTOCOL.md §6.2 duplicates: ignored, counted, never replacing stored content; a 200 acknowledges them. */
import { describe, expect, it } from 'vitest';
import { TestGroup, unsequenced } from './harness.ts';

describe('§6.2 duplicate ids', () => {
  it('across requests: the second request reports duplicates: 1 and the stored content is not replaced', async () => {
    const group = TestGroup.fresh();
    const a = group.envelope();
    const b = group.envelope();
    const first = await group.appendOk([a, b]);
    expect(first).toMatchObject({ accepted: 2, duplicates: 0, seq: 2 });

    const bAgain = group.envelope({ id: b.id }); // same id, different nonce and ciphertext
    expect(bAgain.c).not.toBe(b.c);
    const c = group.envelope();
    const second = await group.appendOk([bAgain, c]);
    expect(second).toMatchObject({ accepted: 1, duplicates: 1, seq: 3, epoch: first.epoch });

    const page = await group.readOk();
    expect(page.events.map(unsequenced)).toEqual([a, b, c]);
    expect(page.events.map((e) => e.seq)).toEqual([1, 2, 3]); // a duplicate consumes no seq
  });

  it('within one request: an id sent twice is stored once, counted as accepted 1 + duplicates 1, first occurrence kept', async () => {
    const group = TestGroup.fresh();
    const a = group.envelope();
    const aAgain = group.envelope({ id: a.id });
    const ack = await group.appendOk([a, aAgain]);
    expect(ack).toMatchObject({ accepted: 1, duplicates: 1, seq: 1 });
    // The second occurrence meets an id that already exists, and stored content is never replaced.
    expect((await group.readOk()).events.map(unsequenced)).toEqual([a]);
  });

  it('within one request, byte-identical repeats: [x, x, x] → accepted 1, duplicates 2', async () => {
    const group = TestGroup.fresh();
    const x = group.envelope();
    expect(await group.appendOk([x, x, x])).toMatchObject({ accepted: 1, duplicates: 2, seq: 1 });
    expect((await group.readOk()).events.map(unsequenced)).toEqual([x]);
  });

  it('mixed: [new, stored, new-again] → accepted 1, duplicates 2, and seq advances by one', async () => {
    const group = TestGroup.fresh();
    const stored = group.envelope();
    await group.appendOk([stored]);
    const fresh = group.envelope();
    expect(await group.appendOk([fresh, stored, fresh])).toMatchObject({ accepted: 1, duplicates: 2, seq: 2 });
    expect((await group.readOk()).events.map(unsequenced)).toEqual([stored, fresh]);
  });

  it('a request made only of duplicates is a 200 that acknowledges all of them and changes nothing', async () => {
    const group = TestGroup.fresh();
    const sent = group.envelopes(3);
    const first = await group.appendOk(sent);
    const replay = await group.appendOk(sent);
    expect(replay).toMatchObject({ accepted: 0, duplicates: 3, seq: 3, epoch: first.epoch });
    const page = await group.readOk();
    expect(page.events.map(unsequenced)).toEqual(sent);
    expect(page.next).toBe(3);
  });
});
