/**
 * The published limits, read from the D1 `limits` table, and the /v1/info document built from them
 * (PROTOCOL.md §6.1). The table is seeded from the EVEN_* vars (scripts/seed-limits.mjs); the triggers read the same
 * table, so what /v1/info says and what the server does cannot drift.
 */
import { LIMIT_VARIABLES, type LimitKey } from './vars';

export const PROTOCOL_VERSIONS = [1] as const;

export type Limits = Readonly<Record<LimitKey, number>>;

/** A limit row is missing: fail closed (500) rather than enforce or publish a guess. */
export class LimitsMissing extends Error {
  readonly missing: string[];
  constructor(missing: string[]) {
    super('limits table is incomplete');
    this.name = 'LimitsMissing';
    this.missing = missing;
  }
}

export function limitsFromRows(rows: ReadonlyArray<{ key: unknown; value: unknown }>): Limits {
  const values = new Map<unknown, unknown>(rows.map((row) => [row.key, row.value]));
  const limits: Partial<Record<LimitKey, number>> = {};
  const missing: string[] = [];
  for (const { key } of LIMIT_VARIABLES) {
    const value = values.get(key);
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) limits[key] = value;
    else missing.push(key);
  }
  if (missing.length > 0) throw new LimitsMissing(missing);
  return limits as Limits;
}

/**
 * The largest append body worth reading. Derived from published limits and never tighter than they imply (a full
 * batch of maximum-size envelopes is about half of this); anything larger must break max_batch or max_event_bytes.
 * Same formula as the Python reference.
 */
export function maxBodyBytes(limits: Limits): number {
  const perEnvelope = 4 * Math.ceil(limits.max_event_bytes / 3) + 256;
  return Math.max(1 << 20, 2 * limits.max_batch * perEnvelope);
}

export interface InfoDocument {
  protocol: number[];
  limits: {
    max_event_bytes: number;
    max_group_bytes: number;
    max_group_events: number;
    max_batch: number;
    max_page: number;
    daily_write_budget: number;
    rate: {
      requests_per_minute: number;
      writes_per_minute: number;
      group_creates_per_minute: number;
    };
  };
  retention_days: number;
  push: false;
  operator?: string;
  terms?: string;
}

export function infoDocument(limits: Limits, operator: unknown, terms: unknown): InfoDocument {
  const doc: InfoDocument = {
    protocol: [...PROTOCOL_VERSIONS],
    limits: {
      max_event_bytes: limits.max_event_bytes,
      max_group_bytes: limits.max_group_bytes,
      max_group_events: limits.max_group_events,
      max_batch: limits.max_batch,
      max_page: limits.max_page,
      daily_write_budget: limits.daily_write_budget,
      rate: {
        requests_per_minute: limits.requests_per_minute,
        writes_per_minute: limits.writes_per_minute,
        group_creates_per_minute: limits.group_creates_per_minute,
      },
    },
    retention_days: limits.retention_days,
    push: false,
  };
  if (typeof operator === 'string' && operator.trim() !== '') doc.operator = operator.trim();
  if (typeof terms === 'string' && terms.trim() !== '') doc.terms = terms.trim();
  return doc;
}

/**
 * Keys whose table value differs from the EVEN_* var of the running deployment: a var was changed without
 * re-seeding. The table still wins (it is what the triggers enforce); this only feeds a warning.
 */
export function driftFromVars(limits: Limits, vars: object): string[] {
  const drifted: string[] = [];
  for (const { variable, key } of LIMIT_VARIABLES) {
    const raw: unknown = Reflect.get(vars, variable);
    if (raw === undefined || raw === '') continue;
    if (Number(raw) !== limits[key]) drifted.push(key);
  }
  return drifted;
}
