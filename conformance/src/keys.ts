/**
 * PROTOCOL.md §2 (key derivation), §3 (sealing) and §4 (envelopes), re-implemented from the protocol text.
 *
 * The suite deliberately does not import @even/core (it lives in another repository). `keys.test.ts` pins this module
 * to the same known-answer vectors as even-app/packages/core/src/keys.test.ts and envelope.test.ts, so the two
 * implementations cannot drift without a test failing on one side.
 *
 * Also here: helpers that build deliberately malformed envelopes for the validation tests.
 */
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';

export const HKDF_SALT = 'even/v1';
export const HKDF_INFO_ENC = 'enc';
export const HKDF_INFO_LOCAL = 'local';
export const HKDF_INFO_AUTH_PREFIX = 'auth|';
export const AAD_PREFIX = 'even/v1';

export const SECRET_BYTES = 32;
export const ID_BYTES = 16; // → 22 base64url characters
export const NONCE_BYTES = 24; // → 32 base64url characters
export const TAG_BYTES = 16;
export const PAD_BLOCK = 256;
/** Structural floor for a decoded `c` (§4): the 16-byte tag plus one byte. */
export const MIN_C_BYTES = TAG_BYTES + 1;
/** Stored size of an envelope for cap accounting (§4) is decoded `c` + this. */
export const STORED_OVERHEAD = 64;

// ---------- base64url without padding (RFC 4648 §5), strict ----------

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const LOOKUP: Int8Array = (() => {
  const table = new Int8Array(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i++) table[ALPHABET.charCodeAt(i)] = i;
  return table;
})();

function sextet(text: string, index: number): number {
  const code = text.charCodeAt(index);
  return code < 128 ? (LOOKUP[code] ?? -1) : -1;
}

export function b64urlEncode(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += ALPHABET[(n >>> 18) & 63]! + ALPHABET[(n >>> 12) & 63]! + ALPHABET[(n >>> 6) & 63]! + ALPHABET[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = (bytes[i] ?? 0) << 16;
    out += ALPHABET[(n >>> 18) & 63]! + ALPHABET[(n >>> 12) & 63]!;
  } else if (rest === 2) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8);
    out += ALPHABET[(n >>> 18) & 63]! + ALPHABET[(n >>> 12) & 63]! + ALPHABET[(n >>> 6) & 63]!;
  }
  return out;
}

/** Strict: only [A-Za-z0-9_-], no "=", no whitespace; rejects lengths ≡ 1 (mod 4). */
export function b64urlDecode(text: string): Uint8Array {
  if (text.length % 4 === 1) throw new RangeError(`invalid base64url length ${text.length}`);
  const out = new Uint8Array(decodedLength(text.length));
  let o = 0;
  let i = 0;
  for (; i + 3 < text.length; i += 4) {
    const a = sextet(text, i), b = sextet(text, i + 1), c = sextet(text, i + 2), d = sextet(text, i + 3);
    if ((a | b | c | d) < 0) throw new RangeError(`invalid base64url character near index ${i}`);
    const n = (a << 18) | (b << 12) | (c << 6) | d;
    out[o++] = (n >>> 16) & 255;
    out[o++] = (n >>> 8) & 255;
    out[o++] = n & 255;
  }
  const rest = text.length - i;
  if (rest >= 2) {
    const a = sextet(text, i), b = sextet(text, i + 1), c = rest === 3 ? sextet(text, i + 2) : 0;
    if ((a | b | c) < 0) throw new RangeError(`invalid base64url character near index ${i}`);
    const n = (a << 18) | (b << 12) | (c << 6);
    out[o++] = (n >>> 16) & 255;
    if (rest === 3) out[o++] = (n >>> 8) & 255;
  }
  return out;
}

/** Decoded byte length of valid unpadded base64url text of `chars` characters. */
export function decodedLength(chars: number): number {
  return Math.floor((chars * 3) / 4);
}

export function isB64url(text: string, length?: number): boolean {
  if (length !== undefined && text.length !== length) return false;
  if (text.length % 4 === 1) return false;
  for (let i = 0; i < text.length; i++) if (sextet(text, i) < 0) return false;
  return true;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

export function fromUtf8(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

export function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  globalThis.crypto.getRandomValues(out);
  return out;
}

// ---------- §2 key derivation ----------

function derive(secret: Uint8Array, info: string): Uint8Array {
  if (secret.length !== SECRET_BYTES) throw new RangeError(`secret must be ${SECRET_BYTES} bytes`);
  return hkdf(sha256, secret, utf8(HKDF_SALT), utf8(info), 32);
}

export function newSecret(): Uint8Array {
  return randomBytes(SECRET_BYTES);
}

/** Server-independent keys: encryptionKey = HKDF(secret, "even/v1", "enc"); localId = b64url(HKDF(secret, "even/v1", "local")). */
export function deriveLocal(secret: Uint8Array): { encryptionKey: Uint8Array; localId: string } {
  return { encryptionKey: derive(secret, HKDF_INFO_ENC), localId: b64urlEncode(derive(secret, HKDF_INFO_LOCAL)) };
}

/** Per-server credentials: authToken = HKDF(secret, "even/v1", "auth|" + origin); groupId = b64url(SHA-256(authToken)). */
export function deriveServer(secret: Uint8Array, origin: string): { authToken: Uint8Array; token: string; groupId: string } {
  const authToken = derive(secret, HKDF_INFO_AUTH_PREFIX + origin);
  return { authToken, token: b64urlEncode(authToken), groupId: groupIdOf(authToken) };
}

/** groupId = base64url(SHA-256(authToken)): what a server recomputes from the bearer token (§2). */
export function groupIdOf(authToken: Uint8Array): string {
  return b64urlEncode(sha256(authToken));
}

/**
 * The fixed secret behind the optional blocked-group test. It is public on purpose: an operator blocks the group id it
 * derives for their server (`npm run blocked-id`), and the suite can then authenticate as that group and expect 410.
 */
export function blockedGroupSecret(): Uint8Array {
  return sha256(utf8('even conformance suite: blocked group'));
}

// ---------- §3 sealing ----------

export function newId(): string {
  return b64urlEncode(randomBytes(ID_BYTES));
}

/** The padded length a conforming client uses: len(padded) + 16 is the next multiple of 256 above len(plain). */
export function conformingPaddedLength(plainLength: number): number {
  return Math.ceil((plainLength + 1 + TAG_BYTES) / PAD_BLOCK) * PAD_BLOCK - TAG_BYTES;
}

/** ISO/IEC 7816-4 padding: plain || 0x80 || 0x00…, to `paddedLength` (default: the conforming 256-byte size class). */
export function pad(plain: Uint8Array, paddedLength = conformingPaddedLength(plain.length)): Uint8Array {
  if (paddedLength < plain.length + 1) {
    throw new RangeError(`cannot pad ${plain.length} bytes into ${paddedLength}: the 0x80 marker needs one byte`);
  }
  const out = new Uint8Array(paddedLength);
  out.set(plain);
  out[plain.length] = 0x80;
  return out;
}

/** Strips trailing zeros and the single 0x80 marker. */
export function unpad(padded: Uint8Array): Uint8Array {
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0x00) end--;
  if (end < 0 || padded[end] !== 0x80) throw new Error('invalid padding: no 0x80 marker');
  return padded.slice(0, end);
}

/** aad = UTF-8("even/v1|" + groupId + "|" + v + "|" + id) */
export function aadFor(groupId: string, v: number, id: string): Uint8Array {
  return utf8(`${AAD_PREFIX}|${groupId}|${v}|${id}`);
}

export interface Envelope {
  id: string;
  v: number;
  n: string;
  c: string;
}

export interface SealOptions {
  key: Uint8Array;
  groupId: string;
  /** Body bytes (or text, UTF-8 encoded). Defaults to empty. */
  plaintext?: Uint8Array | string;
  id?: string;
  /** Envelope version; it is bound into the AAD, so a v = 2 envelope is sealed as a v = 2 client would seal it. */
  v?: number;
  nonce?: Uint8Array;
  /**
   * Exact decoded length of `c`. Omitted: the conforming 256-byte size class (§3). Given: the plaintext is 7816-4
   * padded to cipherBytes − 16, which is still a real, openable ciphertext but not 256-aligned; this is how the suite
   * hits exact cap boundaries and the 17-byte structural floor. 16 seals an empty message (tag only, no marker).
   */
  cipherBytes?: number;
}

/** Seals a real XChaCha20-Poly1305 envelope, exactly as §3 describes. */
export function seal(options: SealOptions): Envelope {
  const id = options.id ?? newId();
  const v = options.v ?? 1;
  const nonce = options.nonce ?? randomBytes(NONCE_BYTES);
  const plain = typeof options.plaintext === 'string' ? utf8(options.plaintext) : (options.plaintext ?? new Uint8Array(0));
  let padded: Uint8Array;
  if (options.cipherBytes === undefined) {
    padded = pad(plain);
  } else if (options.cipherBytes === TAG_BYTES && plain.length === 0) {
    padded = new Uint8Array(0);
  } else {
    padded = pad(plain, options.cipherBytes - TAG_BYTES);
  }
  const c = xchacha20poly1305(options.key, nonce, aadFor(options.groupId, v, id)).encrypt(padded);
  return { id, v, n: b64urlEncode(nonce), c: b64urlEncode(c) };
}

/** Opens an envelope and returns the unpadded plaintext. Throws if authentication or padding fails. */
export function open(options: { key: Uint8Array; groupId: string; envelope: Envelope }): Uint8Array {
  const { envelope } = options;
  const cipher = xchacha20poly1305(options.key, b64urlDecode(envelope.n), aadFor(options.groupId, envelope.v, envelope.id));
  return unpad(cipher.decrypt(b64urlDecode(envelope.c)));
}

/** Stored size for cap accounting (§4): decoded length of `c` + 64. */
export function storedSize(envelope: Pick<Envelope, 'c'>): number {
  return decodedLength(envelope.c.length) + STORED_OVERHEAD;
}

// ---------- deliberately malformed envelopes ----------

/** A JSON-able object that is not (necessarily) a valid envelope. */
export type Loose = Record<string, unknown>;

export const malformed = {
  /** Adds or overwrites one field, e.g. `withField(e, 'x', 1)` (extra field) or `withField(e, 'v', '1')` (wrong type). */
  withField(envelope: Envelope, field: string, value: unknown): Loose {
    return { ...envelope, [field]: value };
  },

  /** Removes one field. */
  without(envelope: Envelope, field: keyof Envelope): Loose {
    const copy: Loose = { ...envelope };
    delete copy[field];
    return copy;
  },

  /** Replaces the character at `index` (negative counts from the end) with `ch`, keeping the length. */
  withChar(text: string, index: number, ch: string): string {
    const at = index < 0 ? text.length + index : index;
    return text.slice(0, at) + ch + text.slice(at + 1);
  },

  /** Appends standard base64 "=" padding, as a lenient encoder would. Unchanged if the length is already ≡ 0 (mod 4). */
  withPadding(text: string): string {
    return text + '='.repeat((4 - (text.length % 4)) % 4);
  },

  /** Extends or truncates to a length ≡ 1 (mod 4), which no byte string encodes to. */
  impossibleLength(text: string): string {
    const r = text.length % 4;
    return r === 1 ? text : r === 0 ? `${text}A` : text.slice(0, text.length - (r - 1));
  },

  /** `length` random base64url characters (for ids and nonces of the wrong length). */
  chars(length: number): string {
    return b64urlEncode(randomBytes(Math.ceil((length * 3) / 4) + 1)).slice(0, length);
  },
};
