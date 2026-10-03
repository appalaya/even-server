"""SQLite storage (design.md, "Storage model"). Caps and group accounting are
enforced by the triggers in schema.sql; nothing here sums bytes.

A store holds one SQLite connection for the life of the process, so the
database is not reopened (and its WAL checkpointed on close) for every request.
A lock serialises every use of it, so the store is safe to call from any
thread; each operation is a few milliseconds, and expiry runs in small
transactions so that requests interleave with it. Writes run under
`BEGIN IMMEDIATE`, which takes SQLite's write lock before the first `MAX(seq)`
read, so two appends to one group never interleave; SQLite's lock (with a
30-second busy timeout) still covers other processes, for example
`even-server block` run from a shell.
"""

import json
import sqlite3
import threading
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from importlib.resources import files
from typing import Any

from .envelope import Envelope
from .limits import Limits

SCHEMA = files(__package__).joinpath("schema.sql").read_text("utf-8")

# The request's arrival time (`received_at`, PROTOCOL.md section 4; design.md
# "Append"), as in the Worker, held in groups.last_write_at: max(now, the
# previous value + 1). Run before the group row is inserted, so it only ever
# advances a group that already exists (a new group's row is inserted with
# `now`), and only when the request holds an id the group does not, so an
# append of duplicates only changes nothing. The events_count trigger keeps
# last_write_at at or above every created_at in the group, so the new value is
# above every value an earlier request stored.
ADVANCE_ARRIVAL = """
UPDATE groups SET last_write_at = MAX(?1, last_write_at + 1)
 WHERE id = ?2 AND EXISTS (
   SELECT 1 FROM json_each(?3) AS j
    WHERE NOT EXISTS (SELECT 1 FROM events WHERE events.group_id = ?2 AND events.id = j.value)
 )
"""

# seq from MAX(seq) inside the statement, so consecutive inserts get consecutive
# values; created_at is the request's arrival time from the group row, the same
# for every insert of the request. A duplicate id is ignored and keeps its row.
INSERT_EVENT = """
INSERT OR IGNORE INTO events (group_id, seq, id, v, n, c, size, created_at)
  SELECT ?1, COALESCE(MAX(seq), 0) + 1, ?2, ?3, ?4, ?5, ?6, (SELECT last_write_at FROM groups WHERE id = ?1)
    FROM events WHERE group_id = ?1
"""

# The stored arrival time of each of the request's ids, new or already stored.
STORED_ARRIVALS = """
SELECT id, created_at FROM events
 WHERE group_id = ?1 AND id IN (SELECT value FROM json_each(?2))
"""

# The daily write budget counts events stored (design.md, "Global write budget"),
# as in the Worker. Run first in the append transaction, this adds the number of
# the request's ids (already unique) that the group does not hold yet, which is
# exactly the number of inserts that will change a row, since the transaction
# holds the write lock. All duplicates: the SELECT yields no row and nothing is
# written. The counters_budget triggers refuse a count past the budget.
COUNT_NEW_EVENTS = """
INSERT INTO counters (day, writes)
  SELECT ?1, n FROM (
    SELECT COUNT(*) AS n FROM json_each(?2) AS j
     WHERE NOT EXISTS (SELECT 1 FROM events WHERE events.group_id = ?3 AND events.id = j.value)
  ) WHERE n > 0
  ON CONFLICT (day) DO UPDATE SET writes = writes + excluded.writes
"""


# Expiry batches (design.md, "Expiry"), as in the Worker. One batch's groups:
# ?1 cutoff, ?2 groups, ?3 events. Through the groups_last_write_at index,
# oldest first; a group is kept while the events of the groups before it are
# fewer than ?3. The same text in both DELETEs of a batch selects the same groups.
EXPIRY_GROUPS_PER_BATCH = 100
EXPIRY_EVENTS_PER_BATCH = 1_000
EXPIRED_BATCH = """
SELECT id FROM (
  SELECT id, SUM(events) OVER (ORDER BY last_write_at, r ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS before
    FROM (SELECT rowid AS r, id, events, last_write_at FROM groups
           WHERE last_write_at < ?1 ORDER BY last_write_at, rowid LIMIT ?2)
) WHERE COALESCE(before, 0) < ?3
"""


class GroupFull(Exception):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason  # "bytes" | "events"


class OverBudget(Exception):
    pass


@dataclass(frozen=True, slots=True)
class GroupState:
    limits: Limits
    blocked: bool
    exists: bool
    events: int  # the group's event count; within an epoch seq runs 1..events (see read_rows)
    rows_read: int  # rows the prelude read, counted as D1 counts them


def read_rows(state: GroupState, since: int, limit: int) -> int:
    """The rows an event read costs in all, counted as the Worker's D1 counts
    them (`meta.rows_read`), so that both references charge a read the same
    units of the read limit (worker/README.md, "Event reads per address"):
    the prelude's rows, the group row for the epoch, and the events after
    `since` up to `limit`, plus one (the look-ahead row that sets `more`, or
    the index entry where the scan stops). Within an epoch seq runs 1..events
    with no gaps, since events are only deleted with their group, so
    `events - since` of them follow `since`. Known before the page is read."""
    following = max(0, state.events - since)
    return state.rows_read + (1 if state.exists else 0) + min(following, limit) + 1


@dataclass(frozen=True, slots=True)
class AppendResult:
    accepted: int
    seq: int
    epoch: str
    # The stored received_at (events.created_at) of every id in the request,
    # those it found already stored included: what the response reports.
    received_at: dict[str, int]
    # The group's last_write_at as it stands after this append (ADVANCE_ARRIVAL
    # above), compared against the request's own now_ms by the caller to warn
    # when a forward clock jump has left it stuck in the future (README.md).
    last_write_at: int


@dataclass(frozen=True, slots=True)
class Page:
    events: list[dict[str, Any]]
    more: bool
    epoch: str | None


class Store:
    def __init__(self, path: str) -> None:
        self.path = path
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(path, timeout=30.0, autocommit=True, check_same_thread=False)
        # FULL, not NORMAL: an acknowledged write that vanished after a power
        # cut would never be re-pushed, because the epoch would not change.
        self._conn.execute("PRAGMA synchronous = FULL")

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    def __enter__(self) -> Store:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    # -- plumbing ---------------------------------------------------------

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        """The connection, held for the duration of the block."""
        with self._lock:
            yield self._conn

    @contextmanager
    def _write(self) -> Iterator[sqlite3.Connection]:
        """The connection inside `BEGIN IMMEDIATE`; commits on success, rolls back on error."""
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            try:
                yield conn
            except BaseException:
                if conn.in_transaction:
                    conn.execute("ROLLBACK")
                raise
            conn.execute("COMMIT")

    @contextmanager
    def _snapshot(self) -> Iterator[sqlite3.Connection]:
        """The connection inside a read transaction: one consistent snapshot."""
        with self._connect() as conn:
            conn.execute("BEGIN")
            try:
                yield conn
            finally:
                if conn.in_transaction:
                    conn.execute("ROLLBACK")

    @staticmethod
    def _limits(conn: sqlite3.Connection) -> Limits:
        return Limits.from_rows(conn.execute("SELECT key, value FROM limits"))

    # -- setup ------------------------------------------------------------

    def init(self) -> None:
        with self._connect() as conn:
            conn.execute("PRAGMA journal_mode = WAL")
            conn.executescript(SCHEMA)

    def seed_limits(self, limits: Limits) -> None:
        with self._write() as conn:
            conn.executemany(
                "INSERT INTO limits (key, value) VALUES (?, ?)"
                " ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                limits.rows(),
            )

    # -- requests ---------------------------------------------------------

    def limits(self) -> Limits:
        with self._connect() as conn:
            return self._limits(conn)

    def group_state(self, group_id: str) -> GroupState:
        with self._snapshot() as conn:
            rows = conn.execute("SELECT key, value FROM limits").fetchall()
            blocked = conn.execute("SELECT 1 FROM blocked WHERE group_id = ?", (group_id,)).fetchone() is not None
            group = conn.execute("SELECT events FROM groups WHERE id = ?", (group_id,)).fetchone()
        return GroupState(
            limits=Limits.from_rows(rows),
            blocked=blocked,
            exists=group is not None,
            events=group[0] if group is not None else 0,
            rows_read=len(rows) + blocked + (group is not None),
        )

    def append(
        self,
        group_id: str,
        envelopes: Sequence[Envelope],
        *,
        epoch: str,
        now_ms: int,
        day: str,
    ) -> AppendResult:
        """Store `envelopes` (already de-duplicated within the request) atomically.

        `epoch` is used only if this write creates the group. Every envelope it
        stores gets the request's arrival time, max(now_ms, the group's previous
        one + 1). Raises `OverBudget` (a budget trigger refused the day's count
        of events stored) or `GroupFull` (the cap trigger refused an insert);
        either way nothing is stored and the count is unchanged.
        """
        ids = json.dumps([e.id for e in envelopes])
        with self._write() as conn:
            try:
                conn.execute(COUNT_NEW_EVENTS, (day, ids, group_id))
            except sqlite3.IntegrityError as exc:
                if "over_budget" not in str(exc):
                    raise
                raise OverBudget() from None
            conn.execute(ADVANCE_ARRIVAL, (now_ms, group_id, ids))
            conn.execute(
                "INSERT OR IGNORE INTO groups (id, epoch, created_at, last_write_at) VALUES (?, ?, ?, ?)",
                (group_id, epoch, now_ms, now_ms),
            )
            accepted = 0
            for e in envelopes:
                try:
                    cursor = conn.execute(INSERT_EVENT, (group_id, e.id, e.v, e.n, e.c, e.size))
                except (sqlite3.IntegrityError, sqlite3.OperationalError) as exc:
                    if "group_full" not in str(exc):
                        raise
                    raise GroupFull(self._full_reason(conn, group_id, e.size)) from None
                accepted += cursor.rowcount  # 1 inserted, 0 ignored as a duplicate
            epoch_now, last_write_at, seq = conn.execute(
                "SELECT epoch, last_write_at, (SELECT MAX(seq) FROM events WHERE group_id = ?) FROM groups WHERE id = ?",
                (group_id, group_id),
            ).fetchone()
            received_at = dict(conn.execute(STORED_ARRIVALS, (group_id, ids)).fetchall())
        if len(received_at) != len(envelopes):
            raise RuntimeError("stored event missing after append")
        return AppendResult(
            accepted=accepted, seq=seq or 0, epoch=epoch_now, received_at=received_at, last_write_at=last_write_at
        )

    @staticmethod
    def _full_reason(conn: sqlite3.Connection, group_id: str, size: int) -> str:
        """Which cap the trigger hit. RAISE(ABORT) undoes only the failing
        statement, so the transaction is still open and the row is current."""
        used = conn.execute("SELECT bytes FROM groups WHERE id = ?", (group_id,)).fetchone()[0]
        cap = conn.execute("SELECT value FROM limits WHERE key = 'max_group_bytes'").fetchone()
        return "bytes" if cap is None or used + size > cap[0] else "events"

    def read(self, group_id: str, since: int, limit: int) -> Page:
        with self._snapshot() as conn:
            row = conn.execute("SELECT epoch FROM groups WHERE id = ?", (group_id,)).fetchone()
            if row is None:
                return Page(events=[], more=False, epoch=None)
            rows = conn.execute(
                "SELECT seq, id, v, n, c, created_at FROM events WHERE group_id = ? AND seq > ? ORDER BY seq LIMIT ?",
                (group_id, since, limit + 1),
            ).fetchall()
        # The protocol's field order, the same as the Worker's.
        events = [{"seq": seq, "id": id_, "v": v, "n": n, "c": c, "received_at": received_at}
                  for seq, id_, v, n, c, received_at in rows[:limit]]
        return Page(events=events, more=len(rows) > limit, epoch=row[0])

    def delete(self, group_id: str) -> None:
        with self._write() as conn:
            conn.execute("DELETE FROM events WHERE group_id = ?", (group_id,))
            conn.execute("DELETE FROM groups WHERE id = ?", (group_id,))

    # -- operator ---------------------------------------------------------

    def block(self, group_id: str, now_ms: int, *, purge: bool = False) -> bool:
        """Add to the blocklist. Returns False if it was already blocked."""
        with self._write() as conn:
            added = conn.execute(
                "INSERT OR IGNORE INTO blocked (group_id, blocked_at) VALUES (?, ?)", (group_id, now_ms)
            ).rowcount
            if purge:
                conn.execute("DELETE FROM events WHERE group_id = ?", (group_id,))
                conn.execute("DELETE FROM groups WHERE id = ?", (group_id,))
        return added == 1

    def unblock(self, group_id: str) -> bool:
        with self._write() as conn:
            return conn.execute("DELETE FROM blocked WHERE group_id = ?", (group_id,)).rowcount == 1

    def expire(
        self,
        cutoff_ms: int,
        *,
        counters_before: str,
        groups_per_batch: int = EXPIRY_GROUPS_PER_BATCH,
        events_per_batch: int = EXPIRY_EVENTS_PER_BATCH,
    ) -> int:
        """Delete groups (and their events) with no write since `cutoff_ms`, and
        daily counters older than `counters_before`. Returns groups deleted.

        Whole groups only, each batch in its own transaction, so that requests
        run between batches and no group is ever left alive with part of its
        log under the same epoch. A batch is at most `groups_per_batch` groups,
        oldest first, taken while the events before them are fewer than
        `events_per_batch` (the first always goes). Runs until none is left."""
        deleted = 0
        args = (cutoff_ms, groups_per_batch, events_per_batch)
        while True:
            with self._write() as conn:
                conn.execute(f"DELETE FROM events WHERE group_id IN ({EXPIRED_BATCH})", args)
                batch = conn.execute(f"DELETE FROM groups WHERE id IN ({EXPIRED_BATCH})", args).rowcount
            deleted += batch
            if batch == 0:
                break
        with self._write() as conn:
            conn.execute("DELETE FROM counters WHERE day < ?", (counters_before,))
        return deleted
