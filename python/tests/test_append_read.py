import pytest

from support import batch, envelope, new_group, read_all


def test_round_trip(client):
    group = new_group()
    sent = [envelope(size=17), envelope(size=300), envelope(size=8192)]
    response = client.post(group.events, json=batch(*sent), headers=group.headers)
    assert response.status_code == 200
    ack = response.json()
    assert ack.keys() == {"accepted", "duplicates", "seq", "epoch"}
    assert (ack["accepted"], ack["duplicates"], ack["seq"]) == (3, 0, 3)
    assert len(ack["epoch"]) == 22

    body = client.get(group.events, headers=group.headers).json()
    assert body == {
        "events": [{"seq": i + 1, **e} for i, e in enumerate(sent)],
        "next": 3,
        "more": False,
        "epoch": ack["epoch"],
    }
    assert list(body["events"][0]) == ["seq", "id", "v", "n", "c"]


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
    assert read_all(client, group) == [{"seq": 1, **a}, {"seq": 2, **b}]


def test_duplicates_across_requests_are_ignored_and_never_replace_content(client):
    group = new_group()
    a = envelope()
    first = client.post(group.events, json=batch(a), headers=group.headers).json()
    c = envelope()
    ack = client.post(group.events, json=batch(envelope(id=a["id"]), c), headers=group.headers).json()
    assert (ack["accepted"], ack["duplicates"], ack["seq"], ack["epoch"]) == (1, 1, 2, first["epoch"])
    assert read_all(client, group) == [{"seq": 1, **a}, {"seq": 2, **c}]


def test_duplicates_only_batch_is_acknowledged(client):
    group = new_group()
    a, b = envelope(), envelope()
    first = client.post(group.events, json=batch(a, b), headers=group.headers).json()
    response = client.post(group.events, json=batch(b, a, b), headers=group.headers)
    assert response.status_code == 200
    assert response.json() == {"accepted": 0, "duplicates": 3, "seq": 2, "epoch": first["epoch"]}


def test_integral_float_version_is_the_same_json_number(client):
    group = new_group()
    e = envelope()
    raw = ('{"events":[{"id":"%s","v":1.0,"n":"%s","c":"%s"}]}' % (e["id"], e["n"], e["c"])).encode()
    response = client.post(group.events, content=raw, headers=group.headers)
    assert response.status_code == 200
    assert read_all(client, group)[0]["v"] == 1
