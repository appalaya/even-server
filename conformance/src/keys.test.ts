/**
 * Known-answer tests for PROTOCOL.md §2 and §3. Offline: `npx vitest run --project kat`.
 *
 * The vectors are copied verbatim from even-app/packages/core/src/keys.test.ts and envelope.test.ts, where they were
 * computed independently (Node crypto, hand-written HChaCha20), not with @noble. If this file and those files ever
 * disagree, the suite and the client derive different tokens and one of them is wrong.
 */
import { createHash, hkdfSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  b64urlDecode,
  b64urlEncode,
  conformingPaddedLength,
  deriveLocal,
  deriveServer,
  fromUtf8,
  groupIdOf,
  isB64url,
  malformed,
  newSecret,
  open,
  pad,
  seal,
  unpad,
  type Envelope,
} from './keys.ts';

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

/** secret = 0x00 0x01 … 0x1f (keys.test.ts) */
const SECRET = Uint8Array.from({ length: 32 }, (_, i) => i);
const DEFAULT = 'https://sync.even.appalaya.com';
const HOME = 'https://home.example.net:8443/even';

/** even-app/packages/core/src/keys.test.ts VECTORS */
const VECTORS = {
  encryptionKeyHex: '05dfaaec81e08821fddda8094319bb1eb24825e65de14fcee95729af87053a6d',
  localId: 'f7tQ_gdG-T-e6rtbgy_FtNT75Yu9ieQs0_mnuysbtI8',
  [DEFAULT]: { authToken: 'Bth1dhK4nn2tJ_RNu2DTi0ZWWiCKyPXtYFJsoUA4TA8', groupId: '5440R1lj0RAH5z7UZJ48_Fbl2cbrEBrp4DFswxKPwTI' },
  [HOME]: { authToken: 'GAL3XisRWEhk3X6FLeypv78mKgTSHgM0OO92ONP8XqM', groupId: 'ohV9w_-dFphsCPCXCv7OQnwDcxnuhBeGmQNKiJkI8z4' },
} as const;

/** even-app/packages/core/src/envelope.test.ts BODY, serialised as JSON.stringify does (no whitespace, key order kept). */
const BODY_JSON =
  '{"sv":1,"type":"group.renamed","name":"Banff 2026","ts":1767225600000,"at":1767225600000,' +
  '"by":"AAAAAAAAAAAAAAAAAAAAAA","dev":"BBBBBBBBBBBBBBBBBBBBBB"}';

/** even-app/packages/core/src/envelope.test.ts VECTOR: key = encryptionKey(SECRET), groupId on DEFAULT, nonce = 0xa0…0xb7. */
const ENVELOPE_VECTOR: Envelope = {
  id: 'Q2bYbA1t6Gq9pD7Zk0xM3w',
  v: 1,
  n: 'oKGio6SlpqeoqaqrrK2ur7CxsrO0tba3',
  c: 'f9jNZ3OVWHdySi5cD7218LFkCwzywbG28VrrAz11KzmKeTAVsQ4pXvDjg8B233CzCD3BUZrYhg80KupwadVsRZEeuSHruNH-lN4yFkhBpKFsHDOUBTjvjT2QYqNG3VEwxLpHxCRHSv6ayxfTt7KKsoPklpeKDh6LY930hTRxMpaPITJJkl6cGtDMzLAR3M-NKypaAGdDgb0Pv6vc59yK2Hg6-6pr14M2M3UB1y4j7EaUVUbMQxXQiGghqMj_V3P1cdgmIwIE9z6X3k1sI3zlsykRJApHe9U1V0HvpoOFjPF8a3lyfWDbcOwqJF4bmiyNMYfkXpC6t8ZWx_PakimaZQ',
};

describe('§2 key derivation: known answers shared with the client', () => {
  it('encryptionKey and localId match the client vectors for secret 0x00…0x1f', () => {
    const { encryptionKey, localId } = deriveLocal(SECRET);
    expect(hex(encryptionKey)).toBe(VECTORS.encryptionKeyHex);
    expect(localId).toBe(VECTORS.localId);
  });

  it.each([DEFAULT, HOME] as const)('authToken and groupId match the client vectors for origin %s', (origin) => {
    const { authToken, token, groupId } = deriveServer(SECRET, origin);
    expect(b64urlEncode(authToken)).toBe(VECTORS[origin].authToken);
    expect(token).toBe(VECTORS[origin].authToken);
    expect(groupId).toBe(VECTORS[origin].groupId);
  });

  it('groupId is base64url(SHA-256(authToken)): 43 characters', () => {
    const { authToken, groupId } = deriveServer(newSecret(), DEFAULT);
    expect(authToken).toHaveLength(32);
    expect(groupId).toBe(groupIdOf(authToken));
    expect(groupId).toBe(createHash('sha256').update(authToken).digest('base64url'));
    expect(groupId).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('agrees with node:crypto HKDF for random secrets (an independent implementation)', () => {
    const salt = Buffer.from('even/v1');
    for (let i = 0; i < 20; i++) {
      const secret = newSecret();
      const origin = `https://server-${i}.example:${8000 + i}/p${i}`;
      const nodeHkdf = (info: string) => new Uint8Array(hkdfSync('sha256', secret, salt, Buffer.from(info), 32));
      expect(hex(deriveLocal(secret).encryptionKey)).toBe(hex(nodeHkdf('enc')));
      expect(deriveLocal(secret).localId).toBe(Buffer.from(nodeHkdf('local')).toString('base64url'));
      const token = nodeHkdf(`auth|${origin}`);
      expect(deriveServer(secret, origin).token).toBe(Buffer.from(token).toString('base64url'));
      expect(deriveServer(secret, origin).groupId).toBe(createHash('sha256').update(token).digest('base64url'));
    }
  });

  it('tokens and group ids differ per origin; the encryption key does not depend on one', () => {
    const secret = newSecret();
    const a = deriveServer(secret, DEFAULT);
    const b = deriveServer(secret, HOME);
    expect(a.token).not.toBe(b.token);
    expect(a.groupId).not.toBe(b.groupId);
    expect(hex(a.authToken)).not.toBe(hex(deriveLocal(secret).encryptionKey));
  });
});

describe('§3 sealing: known answer shared with the client', () => {
  const { encryptionKey: key } = deriveLocal(SECRET);
  const { groupId } = deriveServer(SECRET, DEFAULT);
  const nonce = Uint8Array.from({ length: 24 }, (_, i) => 0xa0 + i);

  it('reproduces the client envelope vector byte for byte (padding, AAD, XChaCha20-Poly1305)', () => {
    const sealed = seal({ key, groupId, plaintext: BODY_JSON, id: ENVELOPE_VECTOR.id, nonce });
    expect(sealed).toEqual(ENVELOPE_VECTOR);
  });

  it('opens the client envelope vector', () => {
    expect(fromUtf8(open({ key, groupId, envelope: ENVELOPE_VECTOR }))).toBe(BODY_JSON);
    expect(b64urlDecode(ENVELOPE_VECTOR.c)).toHaveLength(256);
  });

  it('pads every plaintext length to the 256-byte ciphertext size class and back', () => {
    for (let n = 0; n <= 600; n++) {
      const padded = pad(new Uint8Array(n).fill(0x41));
      expect((padded.length + 16) % 256).toBe(0);
      expect(padded.length).toBe(conformingPaddedLength(n));
      expect(unpad(padded)).toHaveLength(n);
    }
    expect(conformingPaddedLength(8175)).toBe(8176);
  });

  it('seals real ciphertexts of an exact decoded length when asked (16, 17, 300, 8192, 8193)', () => {
    for (const bytes of [16, 17, 300, 8192, 8193]) {
      const envelope = seal({ key, groupId, cipherBytes: bytes });
      expect(b64urlDecode(envelope.c)).toHaveLength(bytes);
      expect(isB64url(envelope.id, 22)).toBe(true);
      expect(isB64url(envelope.n, 32)).toBe(true);
      if (bytes > 16) expect(open({ key, groupId, envelope })).toHaveLength(0);
    }
  });

  it('binds v into the AAD, so a relabelled envelope does not open', () => {
    const v2 = seal({ key, groupId, plaintext: 'x', v: 2 });
    expect(fromUtf8(open({ key, groupId, envelope: v2 }))).toBe('x');
    expect(() => open({ key, groupId, envelope: { ...v2, v: 1 } })).toThrow();
  });
});

describe('base64url and the malformed-envelope helpers', () => {
  it.each([
    [[], ''],
    [[0x66], 'Zg'],
    [[0x66, 0x6f], 'Zm8'],
    [[0x66, 0x6f, 0x6f], 'Zm9v'],
    [[0xfb, 0xff], '-_8'],
    [[0xff, 0xff, 0xff], '____'],
  ])('%j <-> %s (RFC 4648 §5, no padding)', (bytes, text) => {
    expect(b64urlEncode(Uint8Array.from(bytes))).toBe(text);
    expect(Array.from(b64urlDecode(text))).toEqual(bytes);
  });

  it.each(['Zg==', 'ab+c', 'ab/c', 'Zm9 v', 'A', 'AAAAA'])('rejects %j', (text) => {
    expect(() => b64urlDecode(text)).toThrow();
    expect(isB64url(text)).toBe(false);
  });

  it('builds what the validation tests claim to send', () => {
    const envelope = seal({ key: newSecret(), groupId: 'g', plaintext: 'x' });
    expect(malformed.withPadding(envelope.c)).toMatch(/=+$/);
    expect(malformed.withPadding(envelope.c).length % 4).toBe(0);
    expect(malformed.impossibleLength(envelope.c).length % 4).toBe(1);
    expect(malformed.chars(21)).toMatch(/^[A-Za-z0-9_-]{21}$/);
    expect(malformed.chars(33)).toMatch(/^[A-Za-z0-9_-]{33}$/);
    expect(malformed.without(envelope, 'n')).toEqual({ id: envelope.id, v: 1, c: envelope.c });
    expect(malformed.withField(envelope, 'x', 1)).toEqual({ ...envelope, x: 1 });
    expect(malformed.withChar('abcd', -1, '+')).toBe('abc+');
  });
});
