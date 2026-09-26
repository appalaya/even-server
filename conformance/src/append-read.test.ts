/** PROTOCOL.md §6.2 append and §6.3 read: round trip, seq, next, more, epoch, since, limit. */
import { describe, expect, it } from 'vitest';
import { expectEpoch, expectError, expectMissingGroup, limits, oneTo, TestGroup, unsequenced } from './harness.ts';

describe('§6.2/§6.3 append then read', () => {
  it('round-trips envelopes byte for byte, with seq 1..n in request order, and they still decrypt', async () => {
    const group = TestGroup.fresh();
    const sent = group.envelopes(3);
    const ack = await group.appendOk(sent);
    expect(ack).toMatchObject({ accepted: 3, duplicates: 0, seq: 3 });

    const page = await group.readOk();
    expect(page.events.map(unsequenced)).toEqual(sent);
    expect(page.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(page).toMatchObject({ next: 3, more: false, epoch: ack.epoch });
    for (const event of page.events) expect(JSON.parse(group.opened(event))).toMatchObject({ conformance: true });
  });

  it('creates the group implicitly on the first write, with a 22-character epoch (§6.2, §6.6)', async () => {
    const group = TestGroup.fresh();
    expectMissingGroup(await group.readOk());
    const ack = await group.appendOk(group.envelopes(1));
    expectEpoch(ack.epoch, 'first write');
    expect((await group.readOk()).epoch).toBe(ack.epoch);
  });

  it('continues seq across requests; the append response reports the highest seq and the same epoch', async () => {
    const group = TestGroup.fresh();
    const first = await group.appendOk(group.envelopes(2));
    const second = await group.appendOk(group.envelopes(3));
    expect(first.seq).toBe(2);
    expect(second).toMatchObject({ accepted: 3, duplicates: 0, seq: 5, epoch: first.epoch });
    const page = await group.readOk();
    expect(page.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(page.epoch).toBe(first.epoch);
  });

  it('returns only events with seq > since, and next = the last seq returned', async () => {
    const group = TestGroup.fresh();
    const sent = group.envelopes(5);
    const { epoch } = await group.appendOk(sent);
    const page = await group.readOk({ since: 2 });
    expect(page.events.map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(page.events.map(unsequenced)).toEqual(sent.slice(2));
    expect(page).toMatchObject({ next: 5, more: false, epoch });
  });

  it('pages with limit: more is true while events with seq > next exist, then false', async () => {
    const group = TestGroup.fresh();
    const { epoch } = await group.appendOk(group.envelopes(5));
    const p1 = await group.readOk({ limit: 2 });
    expect(p1.events.map((e) => e.seq)).toEqual([1, 2]);
    expect(p1).toMatchObject({ next: 2, more: true, epoch });
    const p2 = await group.readOk({ since: p1.next, limit: 2 });
    expect(p2.events.map((e) => e.seq)).toEqual([3, 4]);
    expect(p2).toMatchObject({ next: 4, more: true, epoch });
    const p3 = await group.readOk({ since: p2.next, limit: 2 });
    expect(p3.events.map((e) => e.seq)).toEqual([5]);
    expect(p3).toMatchObject({ next: 5, more: false, epoch });
  });

  it('more is false when the page ends exactly at the last event', async () => {
    const group = TestGroup.fresh();
    await group.appendOk(group.envelopes(4));
    const page = await group.readOk({ limit: 4 });
    expect(page.events).toHaveLength(4);
    expect(page).toMatchObject({ next: 4, more: false });
  });

  it('since at or beyond the end → empty, next = since, more false, and the (non-null) epoch', async () => {
    const group = TestGroup.fresh();
    const { epoch } = await group.appendOk(group.envelopes(2));
    expect(await group.readOk({ since: 2 })).toMatchObject({ events: [], next: 2, more: false, epoch });
    expect(await group.readOk({ since: 1000 })).toMatchObject({ events: [], next: 1000, more: false, epoch });
  });

  it('limit defaults to max_page and is clamped to it: max_page + 3 events, limit = 10 × max_page', async () => {
    const { max_page } = limits();
    const group = TestGroup.fresh();
    const total = max_page + 3;
    const { epoch } = await group.appendAll(Array.from({ length: total }, () => group.tiny()));

    const clamped = await group.readOk({ limit: 10 * max_page });
    expect(clamped.events.map((e) => e.seq)).toEqual(oneTo(max_page));
    expect(clamped).toMatchObject({ next: max_page, more: true, epoch });

    const byDefault = await group.readOk();
    expect(byDefault.events.map((e) => e.seq)).toEqual(oneTo(max_page));
    expect(byDefault).toMatchObject({ next: max_page, more: true, epoch });

    const rest = await group.readOk({ since: max_page, limit: 10 * max_page });
    expect(rest.events.map((e) => e.seq)).toEqual([max_page + 1, max_page + 2, max_page + 3]);
    expect(rest).toMatchObject({ next: total, more: false, epoch });
  });

  it('limit = 1 returns exactly one event', async () => {
    const group = TestGroup.fresh();
    await group.appendOk(group.envelopes(2));
    const page = await group.readOk({ limit: 1 });
    expect(page.events.map((e) => e.seq)).toEqual([1]);
    expect(page).toMatchObject({ next: 1, more: true });
  });

  it.each([
    ['limit=0', { limit: 0 }],
    ['limit=-1', { limit: -1 }],
    ['limit=abc', { limit: 'abc' }],
    ['since=abc', { since: 'abc' }],
  ])('%s → 400 invalid_request (§6.3, §7 bad query params)', async (_label, query) => {
    const group = TestGroup.fresh();
    await group.appendOk(group.envelopes(1));
    expectError(await group.read(query), 400, 'invalid_request');
  });
});

describe('§6.3 a group that does not exist', () => {
  it('reads as 200 with no events, next = since (0 by default), more false, epoch null', async () => {
    const group = TestGroup.fresh();
    expectMissingGroup(await group.readOk());
    expectMissingGroup(await group.readOk({ since: 7 }), 7);
    expectMissingGroup(await group.readOk({ since: 3, limit: 1 }), 3);
  });
});
