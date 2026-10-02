/**
 * PROTOCOL.md §6.2: seq assignment MUST be atomic per request. Concurrent requests never interleave their sequences
 * and never produce gaps or duplicates. §4: `received_at` is assigned with `seq`, so it holds for concurrent requests
 * too: one value per request, strictly increasing in seq order.
 */
import { describe, expect, it } from 'vitest';
import type { AppendOk, StoredEnvelope } from './client.ts';
import { expectArrivalsPerRequest, limits, oneTo, TestGroup, unsequenced } from './harness.ts';
import type { Envelope } from './keys.ts';

const N = 8;

/** seq is exactly 1..total; each request's envelopes hold consecutive seqs in request order; content is intact. */
function expectAtomic(events: StoredEnvelope[], batches: Envelope[][], acks: AppendOk[], total: number): void {
  expect(events.map((e) => e.seq), 'seq must be exactly 1..total, no gaps or duplicates').toEqual(oneTo(total));
  const byId = new Map(events.map((e) => [e.id, e]));
  expect(byId.size, 'every id stored once').toBe(total);
  batches.forEach((batch, r) => {
    const stored = batch.map((envelope) => byId.get(envelope.id));
    expect(stored.map((e) => (e === undefined ? undefined : unsequenced(e))), `request ${r} stored intact`).toEqual(batch);
    const seqs = stored.map((e) => e?.seq ?? -1);
    const first = seqs[0] ?? -1;
    expect(seqs, `request ${r}: contiguous and in request order`).toEqual(seqs.map((_, i) => first + i));
    // The reported seq is the group's highest after this request's write, so at least this request's last seq.
    expect(acks[r]!.seq, `request ${r}: reported seq`).toBeGreaterThanOrEqual(first + batch.length - 1);
    expect(acks[r]!.seq, `request ${r}: reported seq`).toBeLessThanOrEqual(total);
  });
  expectArrivalsPerRequest(events, batches, acks);
}

describe('§6.2 atomic sequencing under concurrent appends', () => {
  it(`${N} parallel appends of 5 into a new group: seq 1..${N * 5}, each request contiguous with one received_at, one epoch`, async () => {
    const per = Math.min(5, limits().max_batch);
    const group = TestGroup.fresh();
    const batches = Array.from({ length: N }, () => group.envelopes(per));
    const acks = await Promise.all(batches.map((batch) => group.appendOk(batch)));
    for (const ack of acks) expect(ack).toMatchObject({ accepted: per, duplicates: 0 });
    expect(new Set(acks.map((a) => a.epoch)).size, 'concurrent creation must still yield one group with one epoch').toBe(1);

    const all = await group.readAll();
    expect(all.epoch).toBe(acks[0]!.epoch);
    expectAtomic(all.events, batches, acks, N * per);
  });

  it(`${N} parallel appends of 5 into an existing group continue from its seq without gaps`, async () => {
    const per = Math.min(5, limits().max_batch);
    const group = TestGroup.fresh();
    const seed = group.envelope();
    const seeded = await group.appendOk([seed]);
    const { epoch } = seeded;
    const batches = Array.from({ length: N }, () => group.envelopes(per));
    const acks = await Promise.all(batches.map((batch) => group.appendOk(batch)));
    for (const ack of acks) expect(ack).toMatchObject({ accepted: per, duplicates: 0, epoch });

    const all = await group.readAll();
    expect(all.events[0]).toMatchObject({ ...seed, seq: 1 });
    expectAtomic(all.events, [[seed], ...batches], [seeded, ...acks], 1 + N * per);
  });

  it('parallel retries of one batch store it once: accepted sums to the batch size, the rest are duplicates', async () => {
    const per = Math.min(5, limits().max_batch);
    const group = TestGroup.fresh();
    const batch = group.envelopes(per);
    const acks = await Promise.all(Array.from({ length: 6 }, () => group.appendOk(batch)));
    expect(acks.reduce((sum, a) => sum + a.accepted, 0)).toBe(per);
    expect(acks.reduce((sum, a) => sum + a.duplicates, 0)).toBe(5 * per);
    const all = await group.readAll();
    expect(all.events.map(unsequenced)).toEqual(batch);
    expect(all.events.map((e) => e.seq)).toEqual(oneTo(per));
    // One request stored the batch; every retry reports the values it stored, never one of its own (§6.2).
    const stored = all.events.map((e) => e.received_at);
    expect(new Set(stored).size, 'one request stored the batch, so one received_at').toBe(1);
    for (const ack of acks) expect(ack.received_at).toEqual(stored);
  });
});
