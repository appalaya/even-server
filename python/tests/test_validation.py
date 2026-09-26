import json
import secrets

import pytest

from support import b64, batch, envelope, new_group


def _without(e, key):
    return {k: v for k, v in e.items() if k != key}


def _replace(key, value):
    return lambda e: {**e, key: value}


MALFORMED = {
    "extra field": lambda e: {**e, "t": 1},
    "missing id": lambda e: _without(e, "id"),
    "missing v": lambda e: _without(e, "v"),
    "missing n": lambda e: _without(e, "n"),
    "missing c": lambda e: _without(e, "c"),
    "empty object": lambda e: {},
    "id 21 chars": _replace("id", "A" * 21),
    "id 23 chars": _replace("id", "A" * 23),
    "id bad charset": _replace("id", "A" * 21 + "+"),
    "id with padding": _replace("id", "A" * 20 + "=="),
    "id non-ascii": _replace("id", "A" * 21 + "é"),
    "id number": _replace("id", 12345),
    "id null": _replace("id", None),
    "v string": _replace("v", "1"),
    "v bool": _replace("v", True),
    "v fraction": _replace("v", 1.5),
    "v null": _replace("v", None),
    "v list": _replace("v", [1]),
    "n 31 chars": _replace("n", "A" * 31),
    "n 33 chars": _replace("n", "A" * 33),
    "n bad charset": _replace("n", "A" * 31 + "/"),
    "n number": _replace("n", 7),
    "c 16 bytes": _replace("c", b64(secrets.token_bytes(16))),
    "c empty": _replace("c", ""),
    "c over max_event_bytes": _replace("c", b64(secrets.token_bytes(8193))),
    "c padded": _replace("c", b64(secrets.token_bytes(17)) + "="),
    "c standard alphabet": _replace("c", "+/" + b64(secrets.token_bytes(30))[2:]),
    "c whitespace": _replace("c", b64(secrets.token_bytes(18))[:12] + " " + b64(secrets.token_bytes(18))[12:]),
    "c impossible length": _replace("c", "A" * 25),
    "c number": _replace("c", 17),
    "c object": _replace("c", {"x": 1}),
    "envelope is a list": lambda e: list(e.values()),
    "envelope is a string": lambda e: "envelope",
    "envelope is null": lambda e: None,
}


@pytest.mark.parametrize("mutate", MALFORMED.values(), ids=MALFORMED.keys())
def test_malformed_envelope_rejects_whole_batch_with_index(client, mutate):
    group = new_group()
    response = client.post(group.events, json=batch(envelope(), envelope(), mutate(envelope())), headers=group.headers)
    assert response.status_code == 400
    body = response.json()
    assert (body["error"], body["index"]) == ("invalid_envelope", 2)
    assert client.get(group.events, headers=group.headers).json()["epoch"] is None  # nothing stored


@pytest.mark.parametrize("size", [17, 8192])
def test_ciphertext_bounds_are_inclusive(client, size):
    group = new_group()
    assert client.post(group.events, json=batch(envelope(size=size)), headers=group.headers).status_code == 200


@pytest.mark.parametrize("version", [0, 2, -1, 2**70])
def test_unsupported_version_is_415_with_index(client, version):
    group = new_group()
    response = client.post(group.events, json=batch(envelope(), envelope(v=version)), headers=group.headers)
    assert response.status_code == 415
    assert response.json()["error"] == "unsupported_version"
    assert response.json()["index"] == 1
    assert client.get(group.events, headers=group.headers).json()["epoch"] is None


def test_structural_error_takes_precedence_over_version_error(client):
    group = new_group()
    bad = {**envelope(), "extra": True}
    response = client.post(group.events, json=batch(envelope(v=2), envelope(), bad), headers=group.headers)
    assert response.status_code == 400
    assert response.json()["error"] == "invalid_envelope"
    assert response.json()["index"] == 2


def test_first_offender_index_is_reported(client):
    group = new_group()
    response = client.post(group.events, json=batch(envelope(), {}, {}), headers=group.headers)
    assert response.json()["index"] == 1


def test_rejected_batch_stores_nothing_even_in_an_existing_group(client):
    group = new_group()
    client.post(group.events, json=batch(envelope()), headers=group.headers)
    response = client.post(group.events, json=batch(envelope(), envelope(v=9)), headers=group.headers)
    assert response.status_code == 415
    assert len(client.get(group.events, headers=group.headers).json()["events"]) == 1


BAD_BODIES = {
    "not json": b"not json",
    "empty": b"",
    "not utf-8": b"\xff\xfe{}",
    "json array": b"[]",
    "json string": b'"events"',
    "no events": b"{}",
    "events object": b'{"events": {}}',
    "events string": b'{"events": "x"}',
    "events null": b'{"events": null}',
    "empty batch": b'{"events": []}',
    "NaN": b'{"events": NaN}',
    "truncated": b'{"events": [',
    "too deep": b"[" * 100_000 + b"]" * 100_000,
}


@pytest.mark.parametrize("body", BAD_BODIES.values(), ids=BAD_BODIES.keys())
def test_bad_request_shape_is_invalid_request(client, body):
    group = new_group()
    response = client.post(group.events, content=body, headers=group.headers)
    assert response.status_code == 400
    assert response.json().keys() <= {"error", "message"}
    assert response.json()["error"] == "invalid_request"


def test_batch_over_max_batch_is_invalid_request(make_client):
    client = make_client(EVEN_MAX_BATCH=3)
    group = new_group()
    assert client.post(group.events, json=batch(*(envelope() for _ in range(3))), headers=group.headers).status_code == 200
    response = client.post(group.events, json=batch(*(envelope() for _ in range(4))), headers=group.headers)
    assert (response.status_code, response.json()["error"]) == (400, "invalid_request")
    assert "index" not in response.json()


def test_oversized_body_is_invalid_request(client):
    group = new_group()
    body = json.dumps(batch(envelope())).encode() + b" " * (2 << 20)
    response = client.post(group.events, content=body, headers=group.headers)
    assert (response.status_code, response.json()["error"]) == (400, "invalid_request")


@pytest.mark.parametrize("group_id", ["A" * 42, "A" * 44, "A" * 42 + "!", "A" * 42 + "=", "A" * 42 + "."])
def test_malformed_group_id_is_400_before_auth(client, group_id):
    for method, path in [("GET", f"/v1/groups/{group_id}/events"), ("POST", f"/v1/groups/{group_id}/events"),
                         ("DELETE", f"/v1/groups/{group_id}"), ("PUT", f"/v1/groups/{group_id}/subscriptions")]:
        response = client.request(method, path)  # no token at all
        assert response.status_code == 400, (method, path)
        assert response.json()["error"] == "invalid_request"


def test_authentication(client):
    group, other = new_group(), new_group()
    cases = {
        "missing": {},
        "wrong group": other.headers,
        "42 chars": {"Authorization": f"Bearer {group.token[:-1]}"},
        "44 chars": {"Authorization": f"Bearer {group.token}A"},
        "bad charset": {"Authorization": f"Bearer {group.token[:-1]}+"},
        "basic scheme": {"Authorization": f"Basic {group.token}"},
        "no scheme": {"Authorization": group.token},
    }
    for name, headers in cases.items():
        for method, path in [("GET", group.events), ("POST", group.events), ("DELETE", group.path),
                             ("PUT", group.subscriptions)]:
            response = client.request(method, path, headers=headers, json=batch(envelope()))
            assert response.status_code == 401, (name, method)
            assert response.json()["error"] == "unauthorized"
    lower = {"Authorization": f"bearer {group.token}"}
    assert client.get(group.events, headers=lower).status_code == 200
