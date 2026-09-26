/**
 * PROTOCOL.md §6.2 caps: accepting a batch MUST NOT push the group past max_group_bytes (sum of stored sizes, §4:
 * decoded c + 64) or max_group_events. If it would, 413 group_full and nothing is stored. Duplicates do not count.
 * The fills use the published limits, and real ciphertexts of exact sizes, so the boundary is hit to the byte.
 */
import { describe, expect, it } from 'vitest';
import type { Reply } from './client.ts';
import { expectError, expectMissingGroup, limits, oneTo, TestGroup, unsequenced } from './harness.ts';
import { MIN_C_BYTES, STORED_OVERHEAD, storedSize } from './keys.ts';

/** Stored size of the smallest valid envelope: 17 + 64. */
const MIN_STORED = MIN_C_BYTES + STORED_OVERHEAD;

/** Splits `total` into as few parts as possible, each within [min, max]. */
function split(total: number, min: number, max: number): number[] {
  const parts = Math.ceil(total / max);
  if (parts * min > total) throw new Error(`cannot split ${total} into parts within [${min}, ${max}]`);
  const base = Math.floor(total / parts);
  const extra = total - base * parts;
  return Array.from({ length: parts }, (_, i) => base + (i < extra ? 1 : 0));
}

/** 413 group_full; `reason` is optional (MAY), but must name the right cap when present. */
function expectGroupFull(reply: Reply, reason: 'bytes' | 'events'): void {
  const body = expectError(reply, 413, 'group_full');
  if (body.reason !== undefined) expect(body.reason, `413 reason: ${reply.text}`).toBe(reason);
}

describe('§6.2 max_group_bytes', () => {
  it('fills to exactly max_group_bytes (duplicates exempt), then one more → 413 group_full and nothing stored', async () => {
    const { max_group_bytes: B, max_event_bytes: E, max_group_events: M, max_batch } = limits();
    const sizes = split(B, MIN_STORED, E + STORED_OVERHEAD);
    expect(sizes.length + 1, `test limits: filling ${B} bytes takes ${sizes.length} events, so max_group_events (${M}) must exceed that`).toBeLessThanOrEqual(M);

    const group = TestGroup.fresh();
    const events = sizes.map((size) => group.envelope({ cipherBytes: size - STORED_OVERHEAD }));
    expect(events.reduce((sum, e) => sum + storedSize(e), 0)).toBe(B);
    const head = events.slice(0, -1);
    const last = events[events.length - 1]!;
    const epoch = head.length > 0 ? (await group.appendAll(head)).epoch : undefined;
    const extra = group.tiny();

    // Whole request: `last` alone would fit exactly, `extra` would not, so neither is stored.
    expectGroupFull(await group.append([last, extra]), 'bytes');
    const partial = await group.readAll();
    expect(partial.events.map(unsequenced)).toEqual(head);

    // Duplicates are not counted: re-sent stored envelopes plus `last` reach exactly max_group_bytes, which is allowed.
    const dups = head.slice(0, Math.min(2, max_batch - 1));
    const full = await group.appendOk([...dups, last]);
    expect(full).toMatchObject({ accepted: 1, duplicates: dups.length, seq: events.length });
    if (epoch !== undefined) expect(full.epoch).toBe(epoch);

    // Now exactly full: the smallest possible envelope is refused, alone or next to duplicates.
    expectGroupFull(await group.append([extra]), 'bytes');
    expectGroupFull(await group.append([events[0]!, extra]), 'bytes');

    // A batch made only of already-stored envelopes against the full group → 200, all acknowledged.
    const replay = events.slice(0, max_batch);
    expect(await group.appendOk(replay)).toMatchObject({ accepted: 0, duplicates: replay.length, seq: events.length, epoch: full.epoch });

    const all = await group.readAll();
    expect(all.events.map(unsequenced)).toEqual(events);
    expect(all.events.map((e) => e.seq)).toEqual(oneTo(events.length));
    expect(all.events.reduce((sum, e) => sum + storedSize(e), 0)).toBe(B);
    expect(all.epoch).toBe(full.epoch);
  });

  it('a first write that would exceed max_group_bytes → 413, and the group is not created', async (context) => {
    const { max_group_bytes: B, max_event_bytes: E, max_group_events: M, max_batch } = limits();
    const count = Math.ceil((B + 1) / (E + STORED_OVERHEAD));
    if (count > max_batch || count > M) context.skip(`one request of ${count} maximum-size events is not allowed by these limits`);
    const group = TestGroup.fresh();
    const batch = Array.from({ length: count }, () => group.envelope({ cipherBytes: E }));
    expect(batch.reduce((sum, e) => sum + storedSize(e), 0)).toBeGreaterThan(B);
    expectGroupFull(await group.append(batch), 'bytes');
    expectMissingGroup(await group.readOk());
  });
});

describe('§6.2 max_group_events', () => {
  it('fills to exactly max_group_events (duplicates exempt), then one more → 413 group_full and nothing stored', async () => {
    const { max_group_bytes: B, max_group_events: M, max_batch } = limits();
    expect((M + 1) * MIN_STORED, `test limits: ${M + 1} minimal events must fit in max_group_bytes (${B})`).toBeLessThanOrEqual(B);
    expect(M, 'max_group_events').toBeGreaterThanOrEqual(3);

    const group = TestGroup.fresh();
    const events = Array.from({ length: M }, () => group.tiny());
    const head = events.slice(0, -1);
    const last = events[events.length - 1]!;
    const { epoch } = await group.appendAll(head);
    const extra = group.tiny();

    // Whole request: one more would reach the cap, two would pass it, so neither is stored.
    expectGroupFull(await group.append([last, extra]), 'events');
    expect(await group.readOk({ since: M - 2 })).toMatchObject({ next: M - 1, more: false, epoch });

    // Duplicates are not counted: re-sent stored envelopes plus `last` reach exactly max_group_events.
    const dups = head.slice(0, Math.min(2, max_batch - 1));
    expect(await group.appendOk([...dups, last])).toMatchObject({ accepted: 1, duplicates: dups.length, seq: M, epoch });

    expectGroupFull(await group.append([extra]), 'events');
    expectGroupFull(await group.append([head[0]!, extra]), 'events');

    const replay = events.slice(-Math.min(max_batch, M));
    expect(await group.appendOk(replay)).toMatchObject({ accepted: 0, duplicates: replay.length, seq: M, epoch });

    const all = await group.readAll();
    expect(all.events.map((e) => e.seq)).toEqual(oneTo(M));
    expect(all.events.map(unsequenced)).toEqual(events);
  });
});
