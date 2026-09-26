/**
 * PROTOCOL.md §4 envelope rules and §6.2 validation: request shape first (400 invalid_request), then envelopes in
 * array order (400 invalid_envelope / 415 unsupported_version, each with the index of the first offender), structural
 * errors before version errors, and whole-batch rejection: if anything is rejected, nothing is stored.
 */
import { describe, expect, it } from 'vitest';
import { client, expectAppendOk, expectError, expectMissingGroup, limits, TestGroup, unsequenced } from './harness.ts';
import { malformed, MIN_C_BYTES, newId, TAG_BYTES } from './keys.ts';

/** Sends [good, bad, good] to a fresh group; expects 400 invalid_envelope at index 1 and nothing stored. */
async function expectRejectedAtIndex1(group: TestGroup, bad: unknown, status = 400, error = 'invalid_envelope'): Promise<void> {
  const reply = await group.append([group.envelope(), bad, group.envelope()]);
  expectError(reply, status, error, { index: 1 });
  expectMissingGroup(await group.readOk()); // not even the group was created
}

describe('§6.2 whole-batch rejection', () => {
  it('one bad envelope among good ones → 400 invalid_envelope with its index, and nothing is stored', async () => {
    const group = TestGroup.fresh();
    const batch = [group.envelope(), group.envelope(), malformed.withField(group.envelope(), 'x', 1), group.envelope()];
    expectError(await group.append(batch), 400, 'invalid_envelope', { index: 2 });
    expectMissingGroup(await group.readOk());
  });

  it('a rejected batch leaves an existing group exactly as it was (events, seq, epoch)', async () => {
    const group = TestGroup.fresh();
    const stored = group.envelopes(2);
    const { epoch } = await group.appendOk(stored);
    const batch = [group.envelope(), malformed.without(group.envelope(), 'c')];
    expectError(await group.append(batch), 400, 'invalid_envelope', { index: 1 });
    const page = await group.readOk();
    expect(page.events.map(unsequenced)).toEqual(stored);
    expect(page).toMatchObject({ next: 2, epoch });
    expect(await group.appendOk([group.envelope()])).toMatchObject({ seq: 3, epoch }); // no seq was burned
  });

  it('reports the first offender when several envelopes are malformed', async () => {
    const group = TestGroup.fresh();
    const batch = [group.envelope(), malformed.without(group.envelope(), 'id'), malformed.without(group.envelope(), 'n')];
    expectError(await group.append(batch), 400, 'invalid_envelope', { index: 1 });
  });

  it('an unsupported v → 415 unsupported_version with its index, and nothing is stored', async () => {
    const group = TestGroup.fresh();
    await expectRejectedAtIndex1(group, group.envelope({ v: 2 }), 415, 'unsupported_version');
  });

  it('several unsupported versions → 415 at the first one', async () => {
    const group = TestGroup.fresh();
    const batch = [group.envelope(), group.envelope({ v: 2 }), group.envelope({ v: 3 })];
    expectError(await group.append(batch), 415, 'unsupported_version', { index: 1 });
  });

  it('400 precedes 415 across the whole batch (§6.2 read as: every envelope is checked structurally before any version check): unknown v at index 0 + structural error at index 2 → 400 invalid_envelope, index 2', async () => {
    // §6.2 read as: every envelope is checked structurally (in array order) before any is checked for its version,
    // so a structural error anywhere wins over an unsupported version earlier in the array.
    const group = TestGroup.fresh();
    const batch = [group.envelope({ v: 2 }), group.envelope(), malformed.withField(group.envelope(), 'x', 1)];
    expectError(await group.append(batch), 400, 'invalid_envelope', { index: 2 });
    expectMissingGroup(await group.readOk());
  });

  it('an envelope that is both malformed and of an unknown version is a 400, not a 415', async () => {
    const group = TestGroup.fresh();
    const both = { ...group.envelope({ v: 2 }), id: 'short' };
    expectError(await group.append([both]), 400, 'invalid_envelope', { index: 0 });
  });

  it('request shape is checked before envelopes: max_batch + 1 malformed envelopes → 400 invalid_request', async () => {
    const group = TestGroup.fresh();
    const batch = Array.from({ length: limits().max_batch + 1 }, () => malformed.without(group.envelope(), 'c'));
    expectError(await group.append(batch), 400, 'invalid_request');
  });
});

describe('§4 malformed envelopes → 400 invalid_envelope with index, nothing stored', () => {
  const cases: Array<[string, (group: TestGroup) => unknown]> = [
    ['an extra field', (g) => malformed.withField(g.envelope(), 'x', 1)],
    ['an extra "seq" field (a read-back envelope echoed as is)', (g) => malformed.withField(g.envelope(), 'seq', 1)],
    ['no id', (g) => malformed.without(g.envelope(), 'id')],
    ['no v', (g) => malformed.without(g.envelope(), 'v')],
    ['no n', (g) => malformed.without(g.envelope(), 'n')],
    ['no c', (g) => malformed.without(g.envelope(), 'c')],
    ['id of 21 characters', (g) => ({ ...g.envelope(), id: malformed.chars(21) })],
    ['id of 23 characters', (g) => ({ ...g.envelope(), id: malformed.chars(23) })],
    ['id with "+" (standard base64 alphabet)', (g) => { const e = g.envelope(); return { ...e, id: malformed.withChar(e.id, 5, '+') }; }],
    ['id with "/"', (g) => { const e = g.envelope(); return { ...e, id: malformed.withChar(e.id, 5, '/') }; }],
    ['id ending in "==" padding', (g) => ({ ...g.envelope(), id: `${malformed.chars(20)}==` })],
    ['id as a number', (g) => malformed.withField(g.envelope(), 'id', 1234567890)],
    ['id null', (g) => malformed.withField(g.envelope(), 'id', null)],
    ['v as the string "1"', (g) => malformed.withField(g.envelope(), 'v', '1')],
    ['v as 1.5', (g) => malformed.withField(g.envelope(), 'v', 1.5)],
    ['v as true', (g) => malformed.withField(g.envelope(), 'v', true)],
    ['v null', (g) => malformed.withField(g.envelope(), 'v', null)],
    ['n of 31 characters', (g) => ({ ...g.envelope(), n: malformed.chars(31) })],
    ['n of 33 characters', (g) => ({ ...g.envelope(), n: malformed.chars(33) })],
    ['n with "/"', (g) => { const e = g.envelope(); return { ...e, n: malformed.withChar(e.n, 7, '/') }; }],
    ['n as a number', (g) => malformed.withField(g.envelope(), 'n', 42)],
    ['c with "+"', (g) => { const e = g.envelope(); return { ...e, c: malformed.withChar(e.c, 10, '+') }; }],
    ['c with "=" padding characters', (g) => { const e = g.envelope(); return { ...e, c: malformed.withPadding(e.c) }; }],
    ['c with a newline', (g) => { const e = g.envelope(); return { ...e, c: `${e.c.slice(0, 76)}\n${e.c.slice(76)}` }; }],
    ['c empty', (g) => malformed.withField(g.envelope(), 'c', '')],
    ['c of an impossible length (≡ 1 mod 4)', (g) => { const e = g.envelope(); return { ...e, c: malformed.impossibleLength(e.c) }; }],
    ['c decoding to 16 bytes (a real tag-only ciphertext, below the 17-byte floor)', (g) => g.envelope({ cipherBytes: TAG_BYTES })],
    ['c decoding to max_event_bytes + 1', (g) => g.envelope({ cipherBytes: limits().max_event_bytes + 1 })],
    ['c as a number', (g) => malformed.withField(g.envelope(), 'c', 7)],
    ['an envelope that is null', () => null],
    ['an envelope that is an array', (g) => Object.values(g.envelope())],
    ['an envelope that is a string', (g) => JSON.stringify(g.envelope())],
  ];

  it.each(cases)('%s', async (_label, make) => {
    const group = TestGroup.fresh();
    await expectRejectedAtIndex1(group, make(group));
  });
});

describe('§4 boundaries that must be accepted, and v', () => {
  it('c decoding to exactly 17 bytes is accepted (the structural floor)', async () => {
    const group = TestGroup.fresh();
    const tiny = group.envelope({ cipherBytes: MIN_C_BYTES });
    expect(await group.appendOk([tiny])).toMatchObject({ accepted: 1 });
    expect((await group.readOk()).events.map(unsequenced)).toEqual([tiny]);
  });

  it('c decoding to exactly max_event_bytes is accepted', async () => {
    const group = TestGroup.fresh();
    const largest = group.envelope({ cipherBytes: limits().max_event_bytes });
    expect(await group.appendOk([largest])).toMatchObject({ accepted: 1 });
    expect((await group.readOk()).events.map(unsequenced)).toEqual([largest]);
  });

  it('an id of 22 characters from the alphabet is accepted even with non-zero trailing bits (the rule is length + charset)', async () => {
    const group = TestGroup.fresh();
    const id = `${newId().slice(0, 21)}_`; // "_" = 63: its low 4 bits are not zero, so no 16-byte string encodes to this
    const envelope = group.envelope({ id });
    expect(await group.appendOk([envelope])).toMatchObject({ accepted: 1 });
    expect((await group.readOk()).events.map(unsequenced)).toEqual([envelope]);
  });

  it('v: 2 (well-formed, unsupported) → 415 unsupported_version with index', async () => {
    const group = TestGroup.fresh();
    await expectRejectedAtIndex1(group, group.envelope({ v: 2 }), 415, 'unsupported_version');
  });

  it('v: 0 → 415 unsupported_version with index (§4 types v as an integer; 0 is an integer this server does not support)', async () => {
    const group = TestGroup.fresh();
    await expectRejectedAtIndex1(group, malformed.withField(group.envelope(), 'v', 0), 415, 'unsupported_version');
  });
});

describe('§6.2 batch bounds and body shape → 400 invalid_request', () => {
  it('an empty events array', async () => {
    const group = TestGroup.fresh();
    expectError(await group.append([]), 400, 'invalid_request');
    expectMissingGroup(await group.readOk());
  });

  it('max_batch + 1 valid envelopes, and nothing is stored', async () => {
    const group = TestGroup.fresh();
    expectError(await group.append(group.envelopes(limits().max_batch + 1)), 400, 'invalid_request');
    expectMissingGroup(await group.readOk());
  });

  it('exactly max_batch valid envelopes is accepted', async () => {
    const group = TestGroup.fresh();
    const { max_batch } = limits();
    expect(await group.appendOk(group.envelopes(max_batch))).toMatchObject({ accepted: max_batch, seq: max_batch });
  });

  it.each<[string, unknown]>([
    ['events is an object', { events: {} }],
    ['events is a string', { events: 'x' }],
    ['events is null', { events: null }],
    ['events is a number', { events: 1 }],
    ['events is missing', {}],
    ['the body is a bare array', []],
    ['the body is JSON null', null],
    ['the body is a JSON string', 'events'],
  ])('%s', async (_label, body) => {
    const group = TestGroup.fresh();
    expectError(await client().appendBody(group.groupId, group.token, { json: body }), 400, 'invalid_request');
    expectMissingGroup(await group.readOk());
  });

  it.each([
    ['a non-JSON body', 'this is not json'],
    ['truncated JSON', '{"events": ['],
    ['an empty body', ''],
  ])('%s', async (_label, raw) => {
    const group = TestGroup.fresh();
    expectError(await client().appendBody(group.groupId, group.token, { body: raw }), 400, 'invalid_request');
    expectMissingGroup(await group.readOk());
  });

  it('a body shaped like the example (events of envelopes) is what is accepted', async () => {
    const group = TestGroup.fresh();
    const reply = await client().appendBody(group.groupId, group.token, { json: { events: [group.envelope()] } });
    expect(expectAppendOk(reply, 1)).toMatchObject({ accepted: 1 });
  });
});
