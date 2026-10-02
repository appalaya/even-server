import logging

import pytest
from fastapi.testclient import TestClient

from even_server.db import read_rows
from even_server.ratelimit import RateLimiter, SlidingWindow, client_address, ip_key, read_units
from support import batch, envelope, new_group

# A group of 600 events and pages of up to 500, as on the public server.
BIG_GROUPS = {"EVEN_MAX_GROUP_EVENTS": 10_000, "EVEN_MAX_GROUP_BYTES": 100_000_000, "EVEN_MAX_PAGE": 500}


class FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def test_requests_per_minute_with_retry_after_and_sliding_window(make_client):
    clock = FakeClock()
    client = make_client(EVEN_RATE_REQUESTS_PER_MINUTE=3, limiter=RateLimiter(clock))
    for _ in range(3):
        assert client.get("/v1/info").status_code == 200
    clock.now += 20
    response = client.get("/v1/info")
    assert response.status_code == 429
    assert response.json()["error"] == "rate_limited"
    assert response.headers["retry-after"] == "40"
    assert response.headers["cache-control"] == "no-store"
    clock.now += 40
    assert client.get("/v1/info").status_code == 200


def test_rate_limit_is_logged_as_limited(make_client, caplog):
    caplog.set_level(logging.INFO)
    client = make_client(EVEN_RATE_REQUESTS_PER_MINUTE=1)
    client.get("/v1/info")
    client.get("/v1/info")
    lines = [r.fields for r in caplog.records if r.name == "even.request"]
    assert [(l["status"], l["limited"]) for l in lines] == [(200, False), (429, True)]


def test_group_routes_count_against_requests_after_auth(make_client):
    client = make_client(EVEN_RATE_REQUESTS_PER_MINUTE=2)
    group = new_group()
    # Unauthenticated requests are rejected before the limiter and do not use it up.
    for _ in range(5):
        assert client.get(group.events).status_code == 401
    assert client.get(group.events, headers=group.headers).status_code == 200
    assert client.get(group.events, headers=group.headers).status_code == 200
    assert client.get(group.events, headers=group.headers).status_code == 429


def test_the_rate_limit_answers_before_the_blocklist(make_client):
    client = make_client(EVEN_RATE_REQUESTS_PER_MINUTE=1)
    group = new_group()
    client.app.state.store.block(group.id, 0)
    assert client.get(group.events, headers=group.headers).status_code == 410  # counted like any request
    assert client.get(group.events, headers=group.headers).status_code == 429


def test_reads_per_minute_count_event_reads_only(make_client):
    clock = FakeClock()
    client = make_client(EVEN_RATE_READS_PER_MINUTE=2, limiter=RateLimiter(clock))
    group = new_group()
    assert client.post(group.events, json=batch(envelope()), headers=group.headers).status_code == 200
    for _ in range(2):
        assert client.get(group.events, headers=group.headers).status_code == 200
    response = client.get(group.events, headers=group.headers)
    assert response.status_code == 429 and response.json()["error"] == "rate_limited"
    assert response.headers["retry-after"] == "60"
    # Other routes are not reads.
    assert client.post(group.events, json=batch(envelope()), headers=group.headers).status_code == 200
    assert client.get("/v1/info").status_code == 200
    assert client.delete(group.path, headers=group.headers).status_code == 204
    clock.now += 60
    assert client.get(group.events, headers=group.headers).status_code == 200


def fill(client, group, count):
    for start in range(0, count, 25):
        envelopes = [envelope(size=17) for _ in range(min(25, count - start))]
        assert client.post(group.events, json=batch(*envelopes), headers=group.headers).status_code == 200


def test_read_rows_counts_rows_as_the_worker_does(make_client):
    """The same counts the Worker's test pins against D1's meta.rows_read: 12
    rows of prelude (11 limits rows and the group row), 1 for the epoch, then
    the events after `since` up to `limit`, plus one."""
    client = make_client(**BIG_GROUPS)
    group = new_group()
    fill(client, group, 600)
    store = client.app.state.store
    state = store.group_state(group.id)
    assert (state.events, state.rows_read) == (600, 12)
    cases = [(600, 500, 14), (0, 500, 514), (0, 86, 100), (0, 87, 101), (5_000, 500, 14), (590, 500, 24)]
    assert [read_rows(state, since, limit) for since, limit, _ in cases] == [rows for _, _, rows in cases]
    assert read_rows(store.group_state(new_group().id), 0, 500) == 12  # no group: 11 + the probe
    assert [read_units(rows) for rows in (0, 14, 100, 101, 514, 601)] == [1, 1, 1, 2, 6, 7]


def test_a_read_costs_a_unit_per_started_100_rows(make_client):
    """A quiet poll (14 rows) costs 1 of the 25 units, a full page (514) 6."""
    clock = FakeClock()
    client = make_client(EVEN_RATE_READS_PER_MINUTE=25, limiter=RateLimiter(clock), **BIG_GROUPS)
    group = new_group()
    fill(client, group, 600)
    quiet = {"since": 600}
    for _ in range(4):
        page = client.get(group.events, headers=group.headers)
        assert page.status_code == 200 and len(page.json()["events"]) == 500 and page.json()["more"]
    # 24 units spent: one quiet poll still fits, then nothing does.
    assert client.get(group.events, params=quiet, headers=group.headers).status_code == 200
    refused = client.get(group.events, params=quiet, headers=group.headers)
    assert refused.status_code == 429 and refused.json()["error"] == "rate_limited"
    assert refused.headers["retry-after"] == "60"
    clock.now += 60
    for _ in range(25):
        assert client.get(group.events, params=quiet, headers=group.headers).status_code == 200
    assert client.get(group.events, params=quiet, headers=group.headers).status_code == 429


def test_a_read_past_the_allowance_is_refused_before_its_page_is_read(make_client):
    clock = FakeClock()
    client = make_client(EVEN_RATE_READS_PER_MINUTE=25, limiter=RateLimiter(clock), **BIG_GROUPS)
    group = new_group()
    fill(client, group, 600)
    for _ in range(4):
        assert client.get(group.events, headers=group.headers).status_code == 200
    store = client.app.state.store
    pages = []
    read = store.read
    store.read = lambda *args: pages.append(args) or read(*args)
    clock.now += 30
    # A fifth full page: its first unit fits (the 25th), the other five do not.
    refused = client.get(group.events, headers=group.headers)
    assert refused.status_code == 429 and refused.json()["error"] == "rate_limited"
    assert refused.headers["retry-after"] == "30"  # when the four pages' units leave the window
    assert pages == []
    assert client.get(group.events, params={"since": 600}, headers=group.headers).status_code == 429
    clock.now += 30
    assert client.get(group.events, headers=group.headers).status_code == 200
    assert len(pages) == 1


def test_a_read_never_costs_more_than_the_whole_allowance(make_client):
    """So a full page fits in a fresh minute even when max_page outgrows the allowance."""
    clock = FakeClock()
    client = make_client(EVEN_RATE_READS_PER_MINUTE=3, limiter=RateLimiter(clock), **BIG_GROUPS)
    group = new_group()
    fill(client, group, 600)
    page = client.get(group.events, headers=group.headers)
    assert page.status_code == 200 and len(page.json()["events"]) == 500
    assert client.get(group.events, params={"since": 600}, headers=group.headers).status_code == 429


def test_sliding_window_counts_a_cost_all_or_nothing():
    window = SlidingWindow()
    window.record("k", 0.0, cost=3)
    window.record("k", 10.0)
    assert window.retry_after("k", 5, 20.0) == 0
    assert window.retry_after("k", 5, 20.0, cost=2) == 40  # one of the three from t=0 must leave
    assert window.retry_after("k", 5, 20.0, cost=5) == 50  # all four must leave, the last at t=70
    assert window.retry_after("k", 5, 20.0, cost=6) == 60  # more than the limit: a whole window
    assert window.retry_after("other", 5, 20.0, cost=5) == 0


def test_writes_per_minute(make_client):
    client = make_client(EVEN_RATE_WRITES_PER_MINUTE=2)
    group = new_group()
    for _ in range(2):
        assert client.post(group.events, json=batch(envelope()), headers=group.headers).status_code == 200
    response = client.post(group.events, json=batch(envelope()), headers=group.headers)
    assert response.status_code == 429 and int(response.headers["retry-after"]) >= 1
    assert len(client.get(group.events, headers=group.headers).json()["events"]) == 2  # reads unaffected


def test_group_creations_per_minute(make_client):
    client = make_client(EVEN_RATE_GROUP_CREATES_PER_MINUTE=2)
    a, b, c = new_group(), new_group(), new_group()
    assert client.post(a.events, json=batch(envelope()), headers=a.headers).status_code == 200
    assert client.post(b.events, json=batch(envelope()), headers=b.headers).status_code == 200
    assert client.post(c.events, json=batch(envelope()), headers=c.headers).status_code == 429
    assert client.get(c.events, headers=c.headers).json()["epoch"] is None
    # Writing to an existing group is not a creation.
    assert client.post(a.events, json=batch(envelope()), headers=a.headers).status_code == 200


def test_invalid_batches_do_not_use_the_write_limiter(make_client):
    client = make_client(EVEN_RATE_WRITES_PER_MINUTE=1)
    group = new_group()
    for _ in range(3):
        assert client.post(group.events, json=batch({}), headers=group.headers).status_code == 400
    assert client.post(group.events, json=batch(envelope()), headers=group.headers).status_code == 200


def test_ipv6_clients_share_a_bucket_per_64(make_client):
    client = make_client(EVEN_RATE_REQUESTS_PER_MINUTE=2, EVEN_TRUST_PROXY_HEADER="X-Forwarded-For")

    def info(address):
        return client.get("/v1/info", headers={"X-Forwarded-For": address}).status_code

    assert info("2001:db8:1:2::1") == 200
    assert info("2001:db8:1:2:ffff:ffff:ffff:ffff") == 200
    assert info("2001:db8:1:2:abcd::9") == 429         # same /64
    assert info("2001:db8:1:3::1") == 200              # next /64
    assert info("192.0.2.1") == 200
    assert info("192.0.2.2") == 200                    # IPv4 is per address


def test_ipv6_socket_peer_is_keyed_by_64(make_client):
    first = make_client(EVEN_RATE_REQUESTS_PER_MINUTE=1, client=("2001:db8:aa:bb::1", 1))
    assert first.get("/v1/info").status_code == 200
    # Same app and limiter, another address in the same /64.
    second = TestClient(first.app, client=("2001:db8:aa:bb:1:2:3:4", 1))
    assert second.get("/v1/info").status_code == 429


def test_proxy_header_is_ignored_unless_configured(make_client):
    client = make_client(EVEN_RATE_REQUESTS_PER_MINUTE=1)
    assert client.get("/v1/info", headers={"X-Forwarded-For": "192.0.2.1"}).status_code == 200
    assert client.get("/v1/info", headers={"X-Forwarded-For": "192.0.2.2"}).status_code == 429


def test_cf_connecting_ip(make_client):
    client = make_client(EVEN_RATE_REQUESTS_PER_MINUTE=1, EVEN_TRUST_PROXY_HEADER="cf-connecting-ip")
    assert client.get("/v1/info", headers={"CF-Connecting-IP": "192.0.2.1"}).status_code == 200
    assert client.get("/v1/info", headers={"CF-Connecting-IP": "192.0.2.2"}).status_code == 200
    assert client.get("/v1/info", headers={"CF-Connecting-IP": "192.0.2.1"}).status_code == 429


@pytest.mark.parametrize(("address", "key"), [
    ("192.0.2.7", "192.0.2.7"),
    ("2001:db8:1:2:3:4:5:6", "2001:db8:1:2::/64"),
    ("2001:DB8:1:2::", "2001:db8:1:2::/64"),
    ("::ffff:192.0.2.7", "192.0.2.7"),
    ("fe80::1%eth0", "fe80::/64"),
    ("testclient", "testclient"),
])
def test_ip_key(address, key):
    assert ip_key(address) == key


def test_client_address_takes_the_rightmost_forwarded_entry_across_every_line():
    assert client_address("127.0.0.1", ["10.9.9.9, 198.51.100.4"]) == "198.51.100.4"
    # A proxy that adds its own line: the last line's last entry, never the client's first line.
    assert client_address("127.0.0.1", ["192.0.2.66", "198.51.100.4"]) == "198.51.100.4"
    assert client_address("127.0.0.1", ["192.0.2.66, 10.0.0.1", "198.51.100.4, 203.0.113.9"]) == "203.0.113.9"
    assert client_address("127.0.0.1", ["garbage"]) == "127.0.0.1"
    assert client_address("127.0.0.1", ["198.51.100.4", "garbage"]) == "127.0.0.1"
    assert client_address("127.0.0.1", []) == "127.0.0.1"
    assert client_address(None, []) == "unknown"


def test_a_client_cannot_choose_its_key_with_an_extra_forwarded_line(make_client):
    """Behind a proxy that appends its own X-Forwarded-For line, a client-sent
    first line used to become the key; now the proxy's line decides."""
    client = make_client(EVEN_RATE_REQUESTS_PER_MINUTE=1, EVEN_TRUST_PROXY_HEADER="X-Forwarded-For")

    def info(*lines):
        return client.get("/v1/info", headers=[("X-Forwarded-For", line) for line in lines]).status_code

    assert info("192.0.2.1", "198.51.100.4") == 200
    assert info("192.0.2.2", "198.51.100.4") == 429  # same real client, a different forged first line
    assert info("192.0.2.1", "198.51.100.5") == 200  # a different real client


def test_limiter_forgets_idle_keys():
    clock = FakeClock()
    limiter = RateLimiter(clock)
    for n in range(50):
        limiter.check(f"192.0.2.{n}", (limiter.requests, 10))
    assert len(limiter.requests) == 50
    clock.now += 61
    limiter.check("198.51.100.1", (limiter.requests, 10))
    assert len(limiter.requests) == 1
