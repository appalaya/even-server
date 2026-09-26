/**
 * D1 storage (design.md, "Storage model"). Caps and group accounting are enforced by the triggers in schema.sql;
 * nothing here sums bytes. Every write is one `batch()`, which D1 runs as a single transaction, and D1 serialises
 * writes per database, so two appends to one group never interleave.
 */
import type { Envelope } from './envelope';
import { limitsFromRows, type Limits } from './limits';

export interface GroupState {
  limits: Limits;
  blocked: boolean;
  exists: boolean;
  /** Append requests counted today (UTC), for the daily write budget. 0 unless asked for. */
  writesToday: number;
}

export interface AppendResult {
  accepted: number;
  seq: number;
  epoch: string;
}

export interface StoredEvent {
  seq: number;
  id: string;
  v: number;
  n: string;
  c: string;
}

export interface Page {
  events: StoredEvent[];
  more: boolean;
  epoch: string | null;
}

/** The cap trigger aborted the batch (RAISE(ABORT, 'group_full')); nothing was written. */
export class GroupFull extends Error {
  constructor() {
    super('group_full');
    this.name = 'GroupFull';
  }
}

/** The budget trigger aborted the batch (RAISE(ABORT, 'over_budget')); nothing was written. */
export class OverBudget extends Error {
  constructor() {
    super('over_budget');
    this.name = 'OverBudget';
  }
}

const SELECT_LIMITS = 'SELECT key, value FROM limits';

/**
 * Seq is computed inside the statement from MAX(seq), so consecutive inserts in one batch get consecutive values.
 * INSERT OR IGNORE skips a duplicate id via UNIQUE (group_id, id) without consuming a seq.
 */
const INSERT_EVENT = `INSERT OR IGNORE INTO events (group_id, seq, id, v, n, c, size, created_at)
  SELECT ?1, COALESCE(MAX(seq), 0) + 1, ?2, ?3, ?4, ?5, ?6, ?7 FROM events WHERE group_id = ?1`;

export async function loadLimits(db: D1Database): Promise<Limits> {
  const { results } = await db.prepare(SELECT_LIMITS).all<{ key: unknown; value: unknown }>();
  return limitsFromRows(results);
}

/** Everything the request prelude needs, in one round trip: limits, blocklist, existence, and today's writes. */
export async function groupState(
  db: D1Database,
  groupId: string,
  day?: string,
): Promise<GroupState> {
  const statements = [
    db.prepare(SELECT_LIMITS),
    db.prepare('SELECT 1 AS hit FROM blocked WHERE group_id = ?').bind(groupId),
    db.prepare('SELECT 1 AS hit FROM groups WHERE id = ?').bind(groupId),
  ];
  if (day !== undefined)
    statements.push(db.prepare('SELECT writes FROM counters WHERE day = ?').bind(day));
  const [limits, blocked, group, counter] = await db.batch<Record<string, unknown>>(statements);
  const writes = counter?.results[0]?.writes;
  return {
    limits: limitsFromRows((limits?.results ?? []) as Array<{ key: unknown; value: unknown }>),
    blocked: (blocked?.results.length ?? 0) > 0,
    exists: (group?.results.length ?? 0) > 0,
    writesToday: typeof writes === 'number' ? writes : 0,
  };
}

/**
 * Stores `envelopes` (already de-duplicated within the request) in one atomic batch (design.md, "Append"):
 * the day's write counter, the group row if it is new (`epoch` is used only then), one insert per envelope in
 * request order, and a final read of the group's epoch and highest seq. Throws OverBudget if the budget trigger fired
 * on the counter, GroupFull if the cap trigger fired on an insert; either way the whole batch is rolled back.
 */
export async function append(
  db: D1Database,
  groupId: string,
  envelopes: readonly Envelope[],
  { epoch, nowMs, day }: { epoch: string; nowMs: number; day: string },
): Promise<AppendResult> {
  const statements = [
    db
      .prepare(
        'INSERT INTO counters (day, writes) VALUES (?, 1) ON CONFLICT (day) DO UPDATE SET writes = writes + 1',
      )
      .bind(day),
    db
      .prepare(
        'INSERT OR IGNORE INTO groups (id, epoch, created_at, last_write_at) VALUES (?, ?, ?, ?)',
      )
      .bind(groupId, epoch, nowMs, nowMs),
    ...envelopes.map((e) =>
      db.prepare(INSERT_EVENT).bind(groupId, e.id, e.v, e.n, e.c, e.size, nowMs),
    ),
    db
      .prepare(
        'SELECT epoch, (SELECT MAX(seq) FROM events WHERE group_id = ?1) AS seq FROM groups WHERE id = ?1',
      )
      .bind(groupId),
  ];
  let results: D1Result<Record<string, unknown>>[];
  try {
    results = await db.batch<Record<string, unknown>>(statements);
  } catch (error) {
    if (abortedWith(error, 'over_budget')) throw new OverBudget();
    if (abortedWith(error, 'group_full')) throw new GroupFull();
    throw error;
  }
  // One insert changed a row or it did not; the count excludes the AFTER trigger's UPDATE of groups.
  const inserts = results.slice(2, 2 + envelopes.length);
  const accepted = inserts.reduce((sum, result) => sum + (result.meta.changes > 0 ? 1 : 0), 0);
  const row = results[results.length - 1]?.results[0];
  if (row === undefined || typeof row.epoch !== 'string')
    throw new Error('group row missing after append');
  return { accepted, seq: typeof row.seq === 'number' ? row.seq : 0, epoch: row.epoch };
}

/** True if a trigger's RAISE(ABORT, reason) is what failed the batch (D1 wraps it; the message keeps the reason). */
function abortedWith(error: unknown, reason: 'group_full' | 'over_budget'): boolean {
  const pattern = new RegExp(`\\b${reason}\\b`);
  for (let e: unknown = error, depth = 0; e instanceof Error && depth < 5; e = e.cause, depth++) {
    if (pattern.test(e.message)) return true;
  }
  return false;
}

/**
 * Which cap a rejected batch would have crossed, for the optional `reason` of 413 (§7 MAY). The batch was rolled
 * back, so this replays it against the current state: skip ids already stored, add sizes in request order, and
 * report the first cap passed (bytes checked first, as in the Python reference). Undefined if a concurrent write
 * changed the state so that nothing is crossed any more; the 413 then goes without a reason.
 */
export async function fullReason(
  db: D1Database,
  groupId: string,
  envelopes: readonly Envelope[],
  limits: Limits,
): Promise<'bytes' | 'events' | undefined> {
  const [group, existing] = await db.batch<Record<string, unknown>>([
    db.prepare('SELECT bytes, events FROM groups WHERE id = ?').bind(groupId),
    db
      .prepare(
        'SELECT id FROM events WHERE group_id = ? AND id IN (SELECT value FROM json_each(?))',
      )
      .bind(groupId, JSON.stringify(envelopes.map((e) => e.id))),
  ]);
  const row = group?.results[0];
  let bytes = typeof row?.bytes === 'number' ? row.bytes : 0;
  let events = typeof row?.events === 'number' ? row.events : 0;
  const stored = new Set((existing?.results ?? []).map((r) => r.id));
  for (const envelope of envelopes) {
    if (stored.has(envelope.id)) continue;
    if (bytes + envelope.size > limits.max_group_bytes) return 'bytes';
    if (events + 1 > limits.max_group_events) return 'events';
    bytes += envelope.size;
    events += 1;
  }
  return undefined;
}

/** One page, read in one snapshot. Fetches `limit + 1` rows: the extra one only says whether there is more. */
export async function read(
  db: D1Database,
  groupId: string,
  since: number,
  limit: number,
): Promise<Page> {
  const [group, events] = await db.batch<Record<string, unknown>>([
    db.prepare('SELECT epoch FROM groups WHERE id = ?').bind(groupId),
    db
      .prepare(
        'SELECT seq, id, v, n, c FROM events WHERE group_id = ? AND seq > ? ORDER BY seq LIMIT ?',
      )
      .bind(groupId, since, limit + 1),
  ]);
  const epoch = group?.results[0]?.epoch;
  if (typeof epoch !== 'string') return { events: [], more: false, epoch: null };
  const rows = (events?.results ?? []) as unknown as StoredEvent[];
  return {
    events: rows.slice(0, limit).map(({ seq, id, v, n, c }) => ({ seq, id, v, n, c })),
    more: rows.length > limit,
    epoch,
  };
}

export async function deleteGroup(db: D1Database, groupId: string): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM events WHERE group_id = ?').bind(groupId),
    db.prepare('DELETE FROM groups WHERE id = ?').bind(groupId),
  ]);
}

/**
 * Deletes groups (and their events) with no write since `cutoffMs`, and daily counters older than
 * `countersBefore`. Returns the number of groups deleted.
 */
export async function expire(
  db: D1Database,
  cutoffMs: number,
  countersBefore: string,
): Promise<number> {
  const [, groups] = await db.batch([
    db
      .prepare(
        'DELETE FROM events WHERE group_id IN (SELECT id FROM groups WHERE last_write_at < ?)',
      )
      .bind(cutoffMs),
    db.prepare('DELETE FROM groups WHERE last_write_at < ?').bind(cutoffMs),
    db.prepare('DELETE FROM counters WHERE day < ?').bind(countersBefore),
  ]);
  return groups?.meta.changes ?? 0;
}
