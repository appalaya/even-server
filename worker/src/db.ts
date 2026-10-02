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
}

export interface AppendResult {
  accepted: number;
  seq: number;
  epoch: string;
  /** D1's `meta.rows_written` summed over the batch: what the daily write budget is sized against (README.md). */
  rowsWritten: number;
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

/**
 * The daily write budget counts events stored (design.md, "Global write budget"). Run first in the append batch, this
 * adds to the day's counter the number of the request's ids (already unique) that the group does not hold yet, which
 * is exactly the number of inserts that will change a row: the batch is one transaction and D1 serialises writes.
 * When every envelope is a duplicate the SELECT yields no row, so nothing is written at all. The counters_budget
 * triggers refuse a count past the budget. `WHERE n > 0` also settles the parser's INSERT … SELECT … ON CONFLICT
 * ambiguity, as SQLite's documentation asks.
 */
const COUNT_NEW_EVENTS = `INSERT INTO counters (day, writes)
  SELECT ?1, n FROM (
    SELECT COUNT(*) AS n FROM json_each(?2) AS j
     WHERE NOT EXISTS (SELECT 1 FROM events WHERE events.group_id = ?3 AND events.id = j.value)
  ) WHERE n > 0
  ON CONFLICT (day) DO UPDATE SET writes = writes + excluded.writes`;

export async function loadLimits(db: D1Database): Promise<Limits> {
  const { results } = await db.prepare(SELECT_LIMITS).all<{ key: unknown; value: unknown }>();
  return limitsFromRows(results);
}

/** Everything the request prelude needs, in one round trip: limits, blocklist, and existence. */
export async function groupState(db: D1Database, groupId: string): Promise<GroupState> {
  const [limits, blocked, group] = await db.batch<Record<string, unknown>>([
    db.prepare(SELECT_LIMITS),
    db.prepare('SELECT 1 AS hit FROM blocked WHERE group_id = ?').bind(groupId),
    db.prepare('SELECT 1 AS hit FROM groups WHERE id = ?').bind(groupId),
  ]);
  return {
    limits: limitsFromRows((limits?.results ?? []) as Array<{ key: unknown; value: unknown }>),
    blocked: (blocked?.results.length ?? 0) > 0,
    exists: (group?.results.length ?? 0) > 0,
  };
}

/**
 * Stores `envelopes` (already de-duplicated within the request) in one atomic batch (design.md, "Append"):
 * the day's count of events stored, the group row if it is new (`epoch` is used only then), one insert per envelope
 * in request order, and a final read of the group's epoch and highest seq. Throws OverBudget if a budget trigger
 * fired on the counter, GroupFull if the cap trigger fired on an insert; either way the whole batch is rolled back.
 */
export async function append(
  db: D1Database,
  groupId: string,
  envelopes: readonly Envelope[],
  { epoch, nowMs, day }: { epoch: string; nowMs: number; day: string },
): Promise<AppendResult> {
  const statements = [
    db.prepare(COUNT_NEW_EVENTS).bind(day, JSON.stringify(envelopes.map((e) => e.id)), groupId),
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
  const rowsWritten = results.reduce((sum, result) => sum + (result.meta.rows_written ?? 0), 0);
  return {
    accepted,
    seq: typeof row.seq === 'number' ? row.seq : 0,
    epoch: row.epoch,
    rowsWritten,
  };
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

/** How much one expiry run may delete (design.md, "Expiry"). */
export interface ExpiryBounds {
  /** At most this many groups per batch. */
  groupsPerBatch: number;
  /**
   * A batch takes groups, longest idle first, while the events of the groups before them are fewer than this. The
   * first group always goes, so a batch holds at most this many events plus one group (at most max_group_events).
   */
  eventsPerBatch: number;
  /** No new batch once the run's batches have written this many D1 rows (`meta.rows_written`). */
  rowsPerRun: number;
  /** At most this many batches of two statements, well inside D1's queries per invocation. */
  batchesPerRun: number;
}

export const EXPIRY_BOUNDS: ExpiryBounds = {
  groupsPerBatch: 100,
  eventsPerBatch: 1_000,
  rowsPerRun: 10_000,
  batchesPerRun: 20,
};

export interface ExpiryResult {
  groups: number;
  rowsWritten: number;
  /** False when the run stopped at a bound with idle groups still left for the next run. */
  complete: boolean;
}

/**
 * One batch's groups: ?1 cutoff, ?2 groups, ?3 events. The inner query reads at most ?2 rows through the
 * groups_last_write_at index, in (last_write_at, rowid) order, the index's own; the window then keeps a group while
 * the events of the groups before it are fewer than ?3. The same text in both DELETEs selects the same groups, since
 * deleting events changes no groups row and the batch is one transaction.
 */
const EXPIRED_BATCH = `SELECT id FROM (
    SELECT id, SUM(events) OVER (ORDER BY last_write_at, r ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS before
      FROM (SELECT rowid AS r, id, events, last_write_at FROM groups
             WHERE last_write_at < ?1 ORDER BY last_write_at, rowid LIMIT ?2)
  ) WHERE COALESCE(before, 0) < ?3`;

/**
 * Deletes groups (with their events) that have had no write since `cutoffMs`, in batches that each delete whole
 * groups atomically, so a group is never left alive with part of its log under the same epoch. Stops when none are
 * left or at a bound in `bounds`; the next run carries on. Also deletes daily counters older than `countersBefore`.
 */
export async function expire(
  db: D1Database,
  cutoffMs: number,
  countersBefore: string,
  bounds: ExpiryBounds = EXPIRY_BOUNDS,
): Promise<ExpiryResult> {
  let groups = 0;
  let rowsWritten = 0;
  let complete = false;
  for (let batch = 0; batch < bounds.batchesPerRun && rowsWritten < bounds.rowsPerRun; batch++) {
    const events = Math.max(1, Math.min(bounds.eventsPerBatch, bounds.rowsPerRun - rowsWritten));
    const [eventsDeleted, groupsDeleted] = await db.batch([
      db
        .prepare(`DELETE FROM events WHERE group_id IN (${EXPIRED_BATCH})`)
        .bind(cutoffMs, bounds.groupsPerBatch, events),
      db
        .prepare(`DELETE FROM groups WHERE id IN (${EXPIRED_BATCH})`)
        .bind(cutoffMs, bounds.groupsPerBatch, events),
    ]);
    const deleted = groupsDeleted?.meta.changes ?? 0;
    groups += deleted;
    rowsWritten +=
      (eventsDeleted?.meta.rows_written ?? 0) + (groupsDeleted?.meta.rows_written ?? 0);
    if (deleted === 0) {
      complete = true;
      break;
    }
  }
  if (!complete) {
    const left = await db
      .prepare('SELECT 1 AS hit FROM groups WHERE last_write_at < ? LIMIT 1')
      .bind(cutoffMs)
      .first();
    complete = left === null;
  }
  await db.prepare('DELETE FROM counters WHERE day < ?').bind(countersBefore).run();
  return { groups, rowsWritten, complete };
}
