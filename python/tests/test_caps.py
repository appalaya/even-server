from support import batch, envelope, new_group, read_all

SIZE = 17 + 64  # stored size of a minimum envelope: decoded c + 64


def test_event_cap(make_client):
    client = make_client(EVEN_MAX_GROUP_EVENTS=5)
    group = new_group()
    stored = [envelope(size=17) for _ in range(4)]
    assert client.post(group.events, json=batch(*stored), headers=group.headers).json()["seq"] == 4

    # Two new envelopes where only one fits: whole request rejected, nothing stored.
    response = client.post(group.events, json=batch(envelope(size=17), envelope(size=17)), headers=group.headers)
    assert response.status_code == 413
    assert response.json() == {"error": "group_full", "message": response.json()["message"], "reason": "events"}
    assert len(read_all(client, group)) == 4

    # Duplicates (across and within the request) do not count toward the cap.
    last = envelope(size=17)
    ack = client.post(group.events, json=batch(*stored, last, last), headers=group.headers).json()
    assert (ack["accepted"], ack["duplicates"], ack["seq"]) == (1, 5, 5)

    # Full now: a new envelope is refused, a duplicates-only batch still succeeds.
    assert client.post(group.events, json=batch(envelope(size=17)), headers=group.headers).status_code == 413
    ack = client.post(group.events, json=batch(stored[0], last), headers=group.headers)
    assert ack.status_code == 200
    assert (ack.json()["accepted"], ack.json()["duplicates"], ack.json()["seq"]) == (0, 2, 5)
    assert len(read_all(client, group)) == 5


def test_byte_cap_counts_decoded_ciphertext_plus_64(make_client):
    client = make_client(EVEN_MAX_GROUP_BYTES=3 * SIZE + 10)
    group = new_group()
    stored = [envelope(size=17) for _ in range(3)]
    assert client.post(group.events, json=batch(*stored), headers=group.headers).status_code == 200

    # 10 bytes of room left: an envelope of stored size 81 does not fit.
    response = client.post(group.events, json=batch(envelope(size=17)), headers=group.headers)
    assert (response.status_code, response.json()["error"], response.json()["reason"]) == (413, "group_full", "bytes")
    assert len(read_all(client, group)) == 3

    # Duplicates are exempt against a byte-full group.
    ack = client.post(group.events, json=batch(*stored), headers=group.headers)
    assert (ack.status_code, ack.json()["accepted"], ack.json()["duplicates"]) == (200, 0, 3)


def test_byte_cap_exact_fit_is_allowed(make_client):
    client = make_client(EVEN_MAX_GROUP_BYTES=2 * SIZE)
    group = new_group()
    response = client.post(group.events, json=batch(envelope(size=17), envelope(size=17)), headers=group.headers)
    assert response.status_code == 200
    assert client.post(group.events, json=batch(envelope(size=17)), headers=group.headers).status_code == 413


def test_group_full_rolls_back_group_creation_and_counter(make_client):
    client = make_client(EVEN_MAX_GROUP_BYTES=SIZE)
    group = new_group()
    response = client.post(group.events, json=batch(envelope(size=17), envelope(size=17)), headers=group.headers)
    assert response.status_code == 413
    assert client.get(group.events, headers=group.headers).json()["epoch"] is None
