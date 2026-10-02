/**
 * PROTOCOL.md §4 `received_at`, and its place in the §6.2 append response: when this server first stored each
 * envelope in the current epoch, in Unix milliseconds. It is assigned once, together with `seq`, and never changed,
 * including by a duplicate write. Every envelope one request stores gets the same value, and it is greater than the
 * value of every envelope an earlier request stored. Clients take it as the latest time an event can claim.
 */
import { describe, expect, it } from 'vitest';
import type { AppendOk, StoredEnvelope } from './client.ts';
import { expectArrivalsPerRequest, expectNearClock, expectStatus, limits, TestGroup } from './harness.ts';
import type { Envelope } from './keys.ts';

/** Long enough for any clock, the server's included, to have moved on. */
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Pulls every event a page of `limit` at a time, so the checks cover more than one page. */
async function pullAll(group: TestGroup, limit = 2): Promise<StoredEnvelope[]> {
  const events: StoredEnvelope[] = [];
  for (let since = 0, guard = 0; ; guard++) {
    if (guard > 1000) throw new Error('pullAll: `more` never became false');
    const page = await group.readOk({ since, limit });
    events.push(...page.events);
    if (!page.more) return events;
    since = page.next;
  }
}

const arrivals = (events: readonly StoredEnvelope[]): Map<string, number> => new Map(events.map((e) => [e.id, e.received_at]));

describe('§4 received_at', () => {
  it('is on every pulled envelope, on every page: a safe integer within 5 minutes of this machine’s clock at the append', async () => {
    const group = TestGroup.fresh();
    const windows = new Map<string, [number, number]>();
    for (const count of [2, 1, 3]) {
      const sent = group.envelopes(count);
      const before = Date.now();
      const ack = await group.appendOk(sent);
      const after = Date.now();
      expectNearClock(ack.received_at, before, after, 'push response');
      for (const envelope of sent) windows.set(envelope.id, [before, after]);
    }
    const events = await pullAll(group);
    expect(events).toHaveLength(6);
    for (const event of events) {
      // expectReadOk has already required a safe integer on every event of every page.
      const [before, after] = windows.get(event.id) ?? [Number.NaN, Number.NaN];
      expectNearClock([event.received_at], before, after, `seq ${event.seq}`);
    }
  });

  it('the push response has one value per envelope, in request order; a duplicate reports the stored value, never a new one', async () => {
    const group = TestGroup.fresh();
    const [a, b, c, d] = [group.envelope(), group.envelope(), group.envelope(), group.envelope()];
    const first = await group.appendOk([a, b, group.envelope({ id: a.id })]); // a again, within the request
    const t1 = first.received_at[0]!;
    expect(first.received_at).toEqual([t1, t1, t1]);

    await pause(20); // a server that stamped duplicates afresh would now report a later time
    const second = await group.appendOk([c, b, group.envelope({ id: c.id }), d, a]);
    expect(second).toMatchObject({ accepted: 2, duplicates: 3 });
    const t2 = second.received_at[0]!;
    expect(second.received_at, 'c, c again and d share this request’s value; b and a report the value stored for them').toEqual([
      t2,
      t1,
      t2,
      t2,
      t1,
    ]);
    expect(t2).toBeGreaterThan(t1);
  });

  it('is stable across re-reads and duplicate re-pushes, whatever content the re-push carries', async () => {
    const group = TestGroup.fresh();
    const sent = group.envelopes(3);
    const ack = await group.appendOk(sent);
    const stored = arrivals((await group.readOk()).events);
    expect(sent.map((e) => stored.get(e.id))).toEqual(ack.received_at);

    await pause(20);
    expect((await group.appendOk(sent)).received_at, 'a byte-identical re-push').toEqual(ack.received_at);
    const rewritten = sent.map((e) => group.envelope({ id: e.id })); // same ids, new nonce and ciphertext
    expect((await group.appendOk(rewritten)).received_at, 'a re-push of the same ids with new content').toEqual(ack.received_at);
    await group.appendOk([group.envelope()]); // a later write leaves earlier values alone too

    for (let read = 0; read < 2; read++) {
      const again = arrivals((await group.readOk()).events);
      expect(sent.map((e) => again.get(e.id)), `re-read ${read + 1}`).toEqual(ack.received_at);
    }
  });

  it('is equal within one request and strictly increasing across requests in seq order, even sent back to back', async () => {
    const group = TestGroup.fresh();
    const most = Math.min(5, limits().max_batch);
    // No pause between requests: on a fast server several arrive within one millisecond.
    const batches = [3, 1, 4, 1, 5, 1, 1, 2].map((n) => group.envelopes(Math.min(n, most)));
    const acks: AppendOk[] = [];
    for (const batch of batches) acks.push(await group.appendOk(batch));
    const events = await pullAll(group, 3);
    expect(events.map((e) => e.id)).toEqual(batches.flat().map((e) => e.id));
    expectArrivalsPerRequest(events, batches, acks);
  });

  it('after DELETE and recreate, every value is new and no earlier than the recreate time', async () => {
    const group = TestGroup.fresh();
    const log = group.envelopes(3);
    const first = await group.appendOk(log);
    await pause(50);
    expectStatus(await group.delete(), 204);

    const before = Date.now();
    const again = await group.appendOk(log); // the same ids, as a client re-pushes its log (§10)
    const after = Date.now();
    expect(again).toMatchObject({ accepted: 3, duplicates: 0 });
    const t = again.received_at[0]!;
    expect(again.received_at).toEqual([t, t, t]);
    expect(t, 'assigned when the recreated copy is written, not kept from the deleted one').toBeGreaterThan(Math.max(...first.received_at));
    expectNearClock(again.received_at, before, after, 'after recreation');
    expect((await group.readOk()).events.map((e) => e.received_at)).toEqual(again.received_at);
  });

  it('push and pull report the same value for every id', async () => {
    const group = TestGroup.fresh();
    const pushed = new Map<string, number>();
    const push = async (sent: Envelope[]): Promise<void> => {
      const ack = await group.appendOk(sent);
      sent.forEach((envelope, i) => {
        const value = ack.received_at[i]!;
        if (pushed.has(envelope.id)) expect(value, `${envelope.id} reported twice`).toBe(pushed.get(envelope.id));
        pushed.set(envelope.id, value);
      });
    };
    const [a, b] = [group.envelope(), group.envelope()];
    await push([a, b]);
    await push([group.envelope(), a, group.envelope()]);
    await push([b, group.envelope({ id: b.id }), group.envelope()]);
    const events = await pullAll(group);
    expect(events).toHaveLength(5);
    expect(new Map(events.map((e) => [e.id, e.received_at]))).toEqual(pushed);
  });
});
