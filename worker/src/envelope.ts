/**
 * Append-body parsing and envelope validation (PROTOCOL.md §4 and §6.2).
 *
 * Order: request shape (`invalid_request`), then every envelope structurally in array order (first offender →
 * `400 invalid_envelope` with `index`), then versions (first offender → `415 unsupported_version` with `index`).
 * A 400 anywhere in the batch wins over a 415 anywhere in the batch.
 */
import { decodedLength, isB64url } from './b64';
import { ApiError, invalidRequest } from './http';
import type { Limits } from './limits';

export const SUPPORTED_VERSIONS: ReadonlySet<number> = new Set([1]);
export const ID_LENGTH = 22; // base64url of 16 random bytes
export const NONCE_LENGTH = 32; // base64url of 24 bytes
export const MIN_CIPHERTEXT = 17;
export const STORED_OVERHEAD = 64; // stored size = decoded length of c + 64

export interface Envelope {
  readonly id: string;
  readonly v: number;
  readonly n: string;
  readonly c: string;
  /** Stored size for cap accounting (§4). */
  readonly size: number;
}

class Malformed extends Error {}

/** Validates a parsed append body. Returns every envelope in request order, in-request duplicates included. */
export function parseAppendBody(
  document: unknown,
  limits: Pick<Limits, 'max_batch' | 'max_event_bytes'>,
): Envelope[] {
  if (!isRecord(document) || !Array.isArray(document.events))
    throw invalidRequest('body must be {"events": [ ... ]}');
  const events: unknown[] = document.events;
  if (events.length < 1 || events.length > limits.max_batch) {
    throw invalidRequest(`events must hold 1 to ${limits.max_batch} envelopes`);
  }
  const envelopes: Envelope[] = [];
  for (const [index, raw] of events.entries()) {
    try {
      envelopes.push(structural(raw, limits.max_event_bytes));
    } catch (error) {
      if (!(error instanceof Malformed)) throw error;
      throw new ApiError(400, 'invalid_envelope', error.message, { index });
    }
  }
  for (const [index, envelope] of envelopes.entries()) {
    if (!SUPPORTED_VERSIONS.has(envelope.v)) {
      throw new ApiError(
        415,
        'unsupported_version',
        `envelope version ${envelope.v} is not supported`,
        { index },
      );
    }
  }
  return envelopes;
}

/** Collapses ids repeated within one request to their first occurrence. */
export function firstOccurrences(envelopes: readonly Envelope[]): Envelope[] {
  const seen = new Set<string>();
  const unique: Envelope[] = [];
  for (const envelope of envelopes) {
    if (seen.has(envelope.id)) continue;
    seen.add(envelope.id);
    unique.push(envelope);
  }
  return unique;
}

const ENVELOPE_KEYS: ReadonlySet<string> = new Set(['id', 'v', 'n', 'c']);

function structural(raw: unknown, maxEventBytes: number): Envelope {
  if (!isRecord(raw)) throw new Malformed('envelope must be an object');
  const keys = Object.keys(raw);
  if (keys.length !== ENVELOPE_KEYS.size || !keys.every((key) => ENVELOPE_KEYS.has(key))) {
    throw new Malformed('envelope must have exactly the fields id, v, n, c');
  }
  const { id, v, n, c } = raw;
  if (!isB64url(id, ID_LENGTH)) throw new Malformed(`id must be ${ID_LENGTH} base64url characters`);
  // JSON has one number type: 1.0 parses to 1 and is accepted, as in the Python reference. Booleans, strings, 0,
  // negatives and fractions are structural errors (§4); a positive integer we do not support is a 415, later.
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1)
    throw new Malformed('v must be a positive integer');
  if (!isB64url(n, NONCE_LENGTH))
    throw new Malformed(`n must be ${NONCE_LENGTH} base64url characters`);
  if (typeof c !== 'string') throw new Malformed('c must be a string');
  const length = decodedLength(c);
  if (length === undefined) throw new Malformed('c must be unpadded base64url');
  if (length < MIN_CIPHERTEXT || length > maxEventBytes) {
    throw new Malformed(`c must decode to ${MIN_CIPHERTEXT}..${maxEventBytes} bytes`);
  }
  return { id, v, n, c, size: length + STORED_OVERHEAD };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
