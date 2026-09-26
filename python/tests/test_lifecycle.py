import sqlite3
import time

import pytest

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


def test_writes_are_counted_even_without_a_budget(client):
    group = new_group()
    client.post(group.events, json=batch(envelope()), headers=group.headers)
    client.post(group.events, json=batch(envelope()), headers=group.headers)
    with sqlite3.connect(client.app.state.store.path) as db:
        assert db.execute("SELECT writes FROM counters").fetchone() == (2,)


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


@pytest.mark.parametrize("argv", [["expire-now"], ["--expire-now"]])
def test_expire_now_on_a_fresh_database(tmp_path, monkeypatch, argv, capsys):
    monkeypatch.setenv("EVEN_DB_PATH", str(tmp_path / "fresh.db"))
    assert main(argv) == 0
    assert "expired 0" in capsys.readouterr().out
