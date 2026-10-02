import sqlite3
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime

import pytest

from even_server.db import OverBudget
from even_server.envelope import Envelope
from even_server.expiry import DAY_MS, expire_once
from even_server.main import main
from support import batch, envelope, new_group, read_all


def test_delete_then_recreate_gets_new_epoch_and_seq_1(client):
    group = new_group()
    first = client.post(group.events, json=batch(envelope(), envelope()), headers=group.headers).json()

    response = client.delete(group.path, headers=group.headers)
    assert response.status_code == 204
    assert response.content == b""
    assert response.headers["cache-control"] == "no-store"
    assert client.get(group.events, headers=group.headers).json() == {
        "events": [], "next": 0, "more": False, "epoch": None}

    again = client.post(group.events, json=batch(envelope()), headers=group.headers).json()
    assert (again["accepted"], again["seq"]) == (1, 1)
    assert again["epoch"] != first["epoch"] and len(again["epoch"]) == 22
    assert [e["seq"] for e in read_all(client, group)] == [1]


def test_delete_is_idempotent_and_needs_the_token(client):
    group = new_group()
    assert client.delete(group.path, headers=group.headers).status_code == 204
    assert client.delete(group.path, headers=group.headers).status_code == 204
    client.post(group.events, json=batch(envelope()), headers=group.headers)
    assert client.delete(group.path, headers=new_group().headers).status_code == 401
    assert len(read_all(client, group)) == 1


def test_blocklist_via_cli_answers_410_everywhere(client, monkeypatch, capsys):
    group = new_group()
    client.post(group.events, json=batch(envelope()), headers=group.headers)
    monkeypatch.setenv("EVEN_DB_PATH", client.app.state.store.path)

    assert main(["block", group.id]) == 0
    assert "blocked" in capsys.readouterr().out
    for method, path in [("GET", group.events), ("POST", group.events), ("DELETE", group.path),
                         ("PUT", group.subscriptions)]:
        response = client.request(method, path, headers=group.headers, json=batch(envelope()))
        assert response.status_code == 410, method
        assert response.json()["error"] == "group_blocked"
    # Authentication still comes first: a wrong token is 401, not 410.
    wrong = {"Authorization": f"Bearer {new_group().token}"}
    assert client.get(group.events, headers=wrong).status_code == 401

    assert main(["unblock", group.id]) == 0
    assert len(read_all(client, group)) == 1  # data was kept


def test_block_purge_deletes_stored_events(client, monkeypatch):
    group = new_group()
    client.post(group.events, json=batch(envelope()), headers=group.headers)
    monkeypatch.setenv("EVEN_DB_PATH", client.app.state.store.path)
    assert main(["block", "--purge", group.id]) == 0
    assert main(["unblock", group.id]) == 0
    assert client.get(group.events, headers=group.headers).json()["epoch"] is None


def test_cli_commands_do_not_reseed_the_servers_limits(client, monkeypatch):
    monkeypatch.setenv("EVEN_DB_PATH", client.app.state.store.path)
    monkeypatch.delenv("EVEN_MAX_GROUP_BYTES", raising=False)  # the shell lacks the server's env
    assert main(["block", new_group().id]) == 0
    assert client.get("/v1/info").json()["limits"]["max_group_bytes"] == 65536


@pytest.mark.parametrize("flag_first", [True, False])
def test_block_accepts_group_ids_that_start_with_a_dash(client, monkeypatch, flag_first):
    monkeypatch.setenv("EVEN_DB_PATH", client.app.state.store.path)
    group_id = "-" + "A" * 42
    argv = ["block", "--purge", group_id] if flag_first else ["block", group_id, "--purge"]
    assert main(argv) == 0
    blocked = client.get(f"/v1/groups/{group_id}/events", headers={"Authorization": "Bearer " + "A" * 43})
    assert blocked.status_code == 401  # auth first; the id is on the blocklist all the same
    with sqlite3.connect(client.app.state.store.path) as db:
        assert db.execute("SELECT group_id FROM blocked").fetchall() == [(group_id,)]
    assert main(["unblock", group_id]) == 0


def test_block_rejects_malformed_group_id(client, monkeypatch):
    monkeypatch.setenv("EVEN_DB_PATH", client.app.state.store.path)
    assert main(["block", "not-a-group-id"]) == 2


def test_daily_write_budget(make_client):
    client = make_client(EVEN_DAILY_WRITE_BUDGET=2)
    group = new_group()
    for _ in range(2):
        assert client.post(group.events, json=batch(envelope()), headers=group.headers).status_code == 200
    response = client.post(group.events, json=batch(envelope()), headers=group.headers)
    assert response.status_code == 503
    assert response.json()["error"] == "over_budget"
    assert 1 <= int(response.headers["retry-after"]) <= 86400
    # Reads still work, and the rejected write stored nothing.
    read = client.get(group.events, headers=group.headers)
    assert read.status_code == 200 and len(read.json()["events"]) == 2
    with sqlite3.connect(client.app.state.store.path) as db:
        assert db.execute("SELECT writes FROM counters").fetchone() == (2,)


def test_daily_write_budget_counts_events_not_appends(make_client):
    client = make_client(EVEN_DAILY_WRITE_BUDGET=4)
    group = new_group()
    a, b, c = envelope(), envelope(), envelope()

    def push(*envelopes):
        return client.post(group.events, json=batch(*envelopes), headers=group.headers)

    def counted():
        with sqlite3.connect(client.app.state.store.path) as db:
            return db.execute("SELECT COALESCE(SUM(writes), 0) FROM counters").fetchone()[0]

    # Two new events (the repeat of `a` is one event): the count goes up by 2, not 1.
    assert push(a, b, a).json() | {"epoch": None} == {"accepted": 2, "duplicates": 1, "seq": 2, "epoch": None}
    assert counted() == 2
    # Three new events would pass the budget by one: refused whole, nothing stored or counted.
    assert push(c, envelope(), envelope()).status_code == 503
    assert counted() == 2
    assert client.get(group.events, headers=group.headers).json()["next"] == 2
    # A duplicate alongside new events counts only the new ones; this fills the day exactly.
    assert push(a, c, envelope()).json()["accepted"] == 2
    assert counted() == 4
    # On a spent day an append of duplicates only still succeeds and writes no counter row.
    with sqlite3.connect(client.app.state.store.path) as db:
        rows_before = db.execute("SELECT COUNT(*) FROM counters").fetchone()
    assert push(a, b, c).json() | {"epoch": None} == {"accepted": 0, "duplicates": 3, "seq": 4, "epoch": None}
    assert counted() == 4
    with sqlite3.connect(client.app.state.store.path) as db:
        assert db.execute("SELECT COUNT(*) FROM counters").fetchone() == rows_before
    assert push(envelope()).status_code == 503


def test_the_first_counted_append_of_a_day_is_checked_too(make_client):
    client = make_client(EVEN_DAILY_WRITE_BUDGET=2)
    group = new_group()
    response = client.post(group.events, json=batch(envelope(), envelope(), envelope()), headers=group.headers)
    assert response.status_code == 503 and response.json()["error"] == "over_budget"
    with sqlite3.connect(client.app.state.store.path) as db:
        assert db.execute("SELECT COUNT(*) FROM counters").fetchone() == (0,)
    assert client.post(group.events, json=batch(envelope(), envelope()), headers=group.headers).status_code == 200


def test_budget_triggers_refuse_a_count_past_it_and_fail_closed_without_its_row(client):
    def add(n):
        db.execute("INSERT INTO counters (day, writes) VALUES ('1999-12-31', ?)"
                   " ON CONFLICT (day) DO UPDATE SET writes = writes + excluded.writes", (n,))

    db = sqlite3.connect(client.app.state.store.path, autocommit=True)
    try:
        db.execute("UPDATE limits SET value = 5 WHERE key = 'daily_write_budget'")
        with pytest.raises(sqlite3.IntegrityError, match="over_budget"):
            add(6)  # the day's first row, already past the budget
        add(3)
        add(2)  # exactly the budget
        with pytest.raises(sqlite3.IntegrityError, match="over_budget"):
            add(1)
        db.execute("UPDATE limits SET value = 0 WHERE key = 'daily_write_budget'")
        add(100)  # 0 means no budget
        db.execute("DELETE FROM limits WHERE key = 'daily_write_budget'")
        with pytest.raises(sqlite3.IntegrityError, match="over_budget"):
            add(1)
        db.execute("DELETE FROM counters")
        with pytest.raises(sqlite3.IntegrityError, match="over_budget"):
            add(1)
    finally:
        db.close()


def test_daily_write_budget_is_exact_under_concurrency(make_client):
    client = make_client(EVEN_DAILY_WRITE_BUDGET=3)
    store = client.app.state.store
    day = datetime.now(UTC).date().isoformat()

    def attempt(_: int) -> str:
        e = envelope()
        try:
            store.append(new_group().id, [Envelope(id=e["id"], v=1, n=e["n"], c=e["c"], size=320)],
                         epoch="E" * 22, now_ms=time.time_ns() // 1_000_000, day=day)
            return "stored"
        except OverBudget:
            return "over_budget"

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = sorted(pool.map(attempt, range(8)))
    assert results == ["over_budget"] * 5 + ["stored"] * 3
    with sqlite3.connect(store.path) as db:
        assert db.execute("SELECT writes FROM counters WHERE day = ?", (day,)).fetchone() == (3,)
        assert db.execute("SELECT COUNT(*) FROM groups").fetchone() == (3,)


def test_events_are_counted_even_without_a_budget(client):
    group = new_group()
    first = envelope()
    client.post(group.events, json=batch(first), headers=group.headers)
    client.post(group.events, json=batch(first, envelope(), envelope()), headers=group.headers)
    with sqlite3.connect(client.app.state.store.path) as db:
        assert db.execute("SELECT writes FROM counters").fetchone() == (3,)


def test_expiry_deletes_only_idle_groups(make_client, monkeypatch, capsys):
    client = make_client(EVEN_RETENTION_DAYS=30)
    idle, active = new_group(), new_group()
    for group in (idle, active):
        client.post(group.events, json=batch(envelope()), headers=group.headers)
    now = time.time_ns() // 1_000_000
    with sqlite3.connect(client.app.state.store.path) as db:
        db.execute("UPDATE groups SET last_write_at = ? WHERE id = ?", (now - 31 * DAY_MS, idle.id))
        db.execute("UPDATE groups SET last_write_at = ? WHERE id = ?", (now - 29 * DAY_MS, active.id))

    assert expire_once(client.app.state.store) == 1
    assert client.get(idle.events, headers=idle.headers).json()["epoch"] is None
    assert len(read_all(client, active)) == 1
    with sqlite3.connect(client.app.state.store.path) as db:
        assert db.execute("SELECT COUNT(*) FROM events").fetchone() == (1,)

    # The cron entry point uses the published retention from the table.
    with sqlite3.connect(client.app.state.store.path) as db:
        db.execute("UPDATE groups SET last_write_at = ?", (now - 31 * DAY_MS,))
    monkeypatch.setenv("EVEN_DB_PATH", client.app.state.store.path)
    monkeypatch.setenv("EVEN_RETENTION_DAYS", "9999")  # ignored: the table says 30
    assert main(["expire-now"]) == 0
    assert "expired 1" in capsys.readouterr().out


def test_expiry_deletes_whole_groups_in_small_transactions(make_client):
    client = make_client(EVEN_RETENTION_DAYS=30, EVEN_MAX_GROUP_EVENTS=200)
    store = client.app.state.store
    now = time.time_ns() // 1_000_000
    sizes = [3, 30, 1, 1, 50, 2]
    idle = [new_group() for _ in sizes]
    for i, (group, size) in enumerate(zip(idle, sizes)):
        for start in range(0, size, 25):
            envelopes = [envelope(size=17) for _ in range(min(25, size - start))]
            assert client.post(group.events, json=batch(*envelopes), headers=group.headers).status_code == 200
        with sqlite3.connect(store.path) as db:
            db.execute("UPDATE groups SET last_write_at = ? WHERE id = ?", (now - 31 * DAY_MS + i, group.id))
    active = new_group()
    client.post(active.events, json=batch(envelope()), headers=active.headers)

    statements: list[str] = []
    store._conn.set_trace_callback(statements.append)
    try:
        deleted = store.expire(now - 30 * DAY_MS, counters_before="2000-01-01", groups_per_batch=2, events_per_batch=10)
    finally:
        store._conn.set_trace_callback(None)
    assert deleted == 6
    # Oldest first: {3, 30}, {1, 1}, {50} (alone, over the event bound), {2}, then an empty batch; plus the counters.
    assert statements.count("BEGIN IMMEDIATE") == 6
    for group in idle:
        assert client.get(group.events, headers=group.headers).json()["epoch"] is None
    with sqlite3.connect(store.path) as db:
        assert db.execute("SELECT COUNT(*) FROM events").fetchone() == (1,)
    assert len(read_all(client, active)) == 1


def test_expiry_reads_idle_groups_through_the_last_write_at_index(client):
    with sqlite3.connect(client.app.state.store.path) as db:
        plan = " ".join(row[3] for row in db.execute(
            "EXPLAIN QUERY PLAN SELECT id FROM groups WHERE last_write_at < ? ORDER BY last_write_at, rowid LIMIT ?",
            (0, 100)))
    assert "groups_last_write_at" in plan and "TEMP B-TREE" not in plan


def test_last_write_at_moves_once_per_append_and_never_backwards(make_client):
    client = make_client()
    store = client.app.state.store
    group = new_group()
    e = envelope()
    stored = lambda: Envelope(id=e["id"], v=1, n=e["n"], c=e["c"], size=320)  # noqa: E731
    store.append(group.id, [stored()], epoch="E" * 22, now_ms=2_000, day="2030-01-01")
    e = envelope()
    store.append(group.id, [stored()], epoch="E" * 22, now_ms=1_000, day="2030-01-01")
    with sqlite3.connect(store.path) as db:
        assert db.execute("SELECT last_write_at, events FROM groups").fetchone() == (2_000, 2)


def test_one_connection_for_the_life_of_the_store(client, monkeypatch):
    opened = []
    real_connect = sqlite3.connect
    monkeypatch.setattr(sqlite3, "connect", lambda *a, **k: opened.append(a) or real_connect(*a, **k))
    group = new_group()
    for _ in range(3):
        client.post(group.events, json=batch(envelope()), headers=group.headers)
        client.get(group.events, headers=group.headers)
    client.get("/v1/info")
    assert opened == []


@pytest.mark.parametrize("argv", [["expire-now"], ["--expire-now"]])
def test_expire_now_on_a_fresh_database(tmp_path, monkeypatch, argv, capsys):
    monkeypatch.setenv("EVEN_DB_PATH", str(tmp_path / "fresh.db"))
    assert main(argv) == 0
    assert "expired 0" in capsys.readouterr().out
