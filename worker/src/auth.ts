/**
 * Stateless membership check (PROTOCOL.md §2). The bearer token is 32 bytes; the group id is
 * base64url(SHA-256(token)). The server stores neither ahead of time and never learns anything else.
 */
import { decode, encode, isB64url } from './b64';
import { invalidRequest, unauthorized } from './http';

export const GROUP_ID_LENGTH = 43; // base64url of 32 bytes
export const TOKEN_LENGTH = 43;

export function isGroupId(value: unknown): value is string {
  return isB64url(value, GROUP_ID_LENGTH);
}

export function checkGroupId(groupId: string): void {
  if (!isGroupId(groupId)) throw invalidRequest('groupId must be 43 base64url characters');
}

/** The decoded token from `Authorization: Bearer <43 chars>`, or undefined. The scheme is case-insensitive. */
export function parseBearer(header: string | null): Uint8Array | undefined {
  if (header === null) return undefined;
  const trimmed = header.trim();
  const space = trimmed.indexOf(' ');
  if (space === -1) return undefined;
  const scheme = trimmed.slice(0, space);
  const token = trimmed.slice(space + 1).replace(/^ +| +$/g, '');
  if (scheme.toLowerCase() !== 'bearer' || !isB64url(token, TOKEN_LENGTH)) return undefined;
  return decode(token);
}

export async function groupIdFor(token: Uint8Array): Promise<string> {
  return encode(new Uint8Array(await crypto.subtle.digest('SHA-256', token)));
}

/** Throws 401 unless the bearer token hashes to `groupId`. The comparand is a public hash, so `===` is fine. */
export async function authenticate(groupId: string, authorization: string | null): Promise<void> {
  const token = parseBearer(authorization);
  if (token === undefined) throw unauthorized('missing or malformed bearer token');
  if ((await groupIdFor(token)) !== groupId) throw unauthorized('token does not match groupId');
}
