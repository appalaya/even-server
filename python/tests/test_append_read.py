import time

import pytest

from even_server.envelope import Envelope, first_occurrences
from support import batch, envelope, new_group, read_all


def test_round_trip(client):
    group = new_group()
    sent = [envelope(size=17), envelope(size=300), envelope(size=8192)]
    before = time.time_ns() // 1_000_000
    response = client.post(group.events, json=batch(*sent), headers=group.headers)
    after = time.time_ns() // 1_000_000
    assert response.status_code == 200
    ack = response.json()
    # The same field order as the Worker: the two agree byte for byte in shape.
    assert list(ack) == ["accepted", "duplicates", "seq", "epoch", "received_at"]
    assert (ack["accepted"], ack["duplicates"], ack["seq"]) == (3, 0, 3)
    assert len(ack["epoch"]) == 22
    arrival = ack["received_at"][0]
    assert ack["received_at"] == [arrival] * 3
    assert before <= arrival <= after

    body = client.get(group.events, headers=group.headers).json()
    assert body == {
        "events": [{"seq": i + 1, **e, "received_at": arrival} for i, e in enumerate(sent)],
        "next": 3,
        "more": False,
        "epoch": ack["epoch"],
    }
    assert list(body["events"][0]) == ["seq", "id", "v", "n", "c", "received_at"]


def test_received_at_is_one_value_per_request_kept_for_duplicates_and_fresh_after_delete(client):
    """max(now, the previous request's value + 1), assigned once with seq."""
    store = client.app.state.store
    group = new_group()

    def at(envelopes, now_ms):
        parsed = [Envelope(id=e["id"], v=1, n=e["n"], c=e["c"], size=320) for e in envelopes]
        result = store.append(group.id, first_occurrences(parsed), epoch="E" * 22, now_ms=now_ms, day="2041-01-01")
        return [result.received_at[e.id] for e in parsed]

    def last_write_at():
        return store._conn.execute("SELECT last_write_at FROM groups WHERE id = ?", (group.id,)).fetchone()[0]

    a, b, c, d, e = (envelope() for _ in range(5))
    assert at([a, b, a], 5_000) == [5_000] * 3
    # A clock behind the last request, then one equal to it: each request still arrives after the one before.
    assert at([c, a, envelope(id=c["id"])], 4_000) == [5_001, 5_000, 5_001]
    assert at([d], 5_001) == [5_002]
    assert at([e], 9_000) == [9_000]
    # Duplicates only: the stored values, and nothing moves.
    assert at([e, d, c, b, a], 20_000) == [9_000, 5_002, 5_001, 5_000, 5_000]
    assert last_write_at() == 9_000
    assert [(x["id"], x["received_at"]) for x in read_all(client, group)] == [
        (a["id"], 5_000), (b["id"], 5_000), (c["id"], 5_001), (d["id"], 5_002), (e["id"], 9_000)]
    # Deleted and recreated: assigned afresh from the clock, not continued from the old incarnation.
    assert client.delete(group.path, headers=group.headers).status_code == 204
    assert at([a, b], 1_000) == [1_000, 1_000]
    assert last_write_at() == 1_000


def test_seq_continues_across_requests(client):
    group = new_group()
    client.post(group.events, json=batch(envelope(), envelope()), headers=group.headers)
    ack = client.post(group.events, json=batch(envelope()), headers=group.headers).json()
    assert (ack["accepted"], ack["seq"]) == (1, 3)
    assert [e["seq"] for e in read_all(client, group)] == [1, 2, 3]


def test_paging_with_since_limit_next_and_more(client):
    group = new_group()
    epoch = client.post(group.events, json=batch(*(envelope() for _ in range(5))), headers=group.headers).json()["epoch"]

    first = client.get(group.events, params={"limit": 2}, headers=group.headers).json()
    assert ([e["seq"] for e in first["events"]], first["next"], first["more"]) == ([1, 2], 2, True)
    second = client.get(group.events, params={"since": 2, "limit": 2}, headers=group.headers).json()
    assert ([e["seq"] for e in second["events"]], second["next"], second["more"]) == ([3, 4], 4, True)
    third = client.get(group.events, params={"since": 4, "limit": 2}, headers=group.headers).json()
    assert ([e["seq"] for e in third["events"]], third["next"], third["more"]) == ([5], 5, False)
    exact = client.get(group.events, params={"since": 3, "limit": 2}, headers=group.headers).json()
    assert (exact["next"], exact["more"]) == (5, False)
    past = client.get(group.events, params={"since": 9}, headers=group.headers).json()
    assert past == {"events": [], "next": 9, "more": False, "epoch": epoch}


def test_limit_defaults_to_and_is_clamped_at_max_page(make_client):
    client = make_client(EVEN_MAX_PAGE=3)
    group = new_group()
    client.post(group.events, json=batch(*(envelope() for _ in range(5))), headers=group.headers)
    for params in ({}, {"limit": 100}, {"limit": "9" * 40}):
        body = client.get(group.events, params=params, headers=group.headers).json()
        assert ([e["seq"] for e in body["events"]], body["next"], body["more"]) == ([1, 2, 3], 3, True)


@pytest.mark.parametrize("params", [
    {"limit": 0}, {"limit": -1}, {"limit": "abc"}, {"limit": ""}, {"limit": "1.5"},
    {"since": -1}, {"since": "x"}, {"since": "1e3"}, {"since": str(2**63)},
])
def test_bad_query_parameters(client, params):
    group = new_group()
    response = client.get(group.events, params=params, headers=group.headers)
    assert response.status_code == 400
    assert response.json()["error"] == "invalid_request"


def test_missing_group_reads_as_empty_with_null_epoch(client):
    group = new_group()
    assert client.get(group.events, headers=group.headers).json() == {
        "events": [], "next": 0, "more": False, "epoch": None}
    assert client.get(group.events, params={"since": 7}, headers=group.headers).json() == {
        "events": [], "next": 7, "more": False, "epoch": None}


def test_duplicates_within_one_request_are_stored_once(client):
    group = new_group()
    a, b = envelope(), envelope()
    a_again = envelope(id=a["id"])  # same id, different content
    ack = client.post(group.events, json=batch(a, a_again, b), headers=group.headers).json()
    assert (ack["accepted"], ack["duplicates"], ack["seq"]) == (2, 1, 2)
    t = ack["received_at"][0]
    assert ack["received_at"] == [t, t, t]
    assert read_all(client, group) == [{"seq": 1, **a, "received_at": t}, {"seq": 2, **b, "received_at": t}]


def test_duplicates_across_requests_are_ignored_and_never_replace_content(client):
    group = new_group()
    a = envelope()
    first = client.post(group.events, json=batch(a), headers=group.headers).json()
    c = envelope()
    ack = client.post(group.events, json=batch(envelope(id=a["id"]), c), headers=group.headers).json()
    assert (ack["accepted"], ack["duplicates"], ack["seq"], ack["epoch"]) == (1, 1, 2, first["epoch"])
    t_a, t_c = first["received_at"][0], ack["received_at"][1]
    assert ack["received_at"] == [t_a, t_c] and t_c > t_a  # the duplicate reports its stored value
    assert read_all(client, group) == [{"seq": 1, **a, "received_at": t_a}, {"seq": 2, **c, "received_at": t_c}]


def test_duplicates_only_batch_is_acknowledged(client):
    group = new_group()
    a, b = envelope(), envelope()
    first = client.post(group.events, json=batch(a, b), headers=group.headers).json()
    response = client.post(group.events, json=batch(b, a, b), headers=group.headers)
    assert response.status_code == 200
    t = first["received_at"][0]
    assert response.json() == {"accepted": 0, "duplicates": 3, "seq": 2, "epoch": first["epoch"], "received_at": [t] * 3}


def test_integral_float_version_is_the_same_json_number(client):
    group = new_group()
    e = envelope()
    raw = ('{"events":[{"id":"%s","v":1.0,"n":"%s","c":"%s"}]}' % (e["id"], e["n"], e["c"])).encode()
    response = client.post(group.events, content=raw, headers=group.headers)
    assert response.status_code == 200
    assert read_all(client, group)[0]["v"] == 1
