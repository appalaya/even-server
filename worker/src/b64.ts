/**
 * base64url without padding (RFC 4648 §5), strictly: the alphabet is checked before anything is decoded, so padding,
 * `+`, `/`, whitespace and anything else are rejected rather than skipped.
 */

const ALPHABET = /^[A-Za-z0-9_-]*$/;

/** True if `value` is a string of alphabet characters (and exactly `length` long, when given). */
export function isB64url(value: unknown, length?: number): value is string {
  if (typeof value !== 'string' || (length !== undefined && value.length !== length)) return false;
  return ALPHABET.test(value);
}

/**
 * Byte length `text` decodes to, without decoding it, or undefined if it is not unpadded base64url (bad character or
 * an impossible length, 4k + 1). Like the Python reference, non-zero trailing bits are not an error.
 */
export function decodedLength(text: string): number | undefined {
  if (!isB64url(text) || text.length % 4 === 1) return undefined;
  return Math.floor((text.length * 3) / 4);
}

/** Decodes unpadded base64url. Throws on anything `decodedLength` rejects. */
export function decode(text: string): Uint8Array {
  if (decodedLength(text) === undefined) throw new TypeError('not unpadded base64url');
  const binary = atob(
    text.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (text.length % 4)) % 4),
  );
  return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
}

export function encode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
