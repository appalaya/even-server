import logging

import pytest
from fastapi.testclient import TestClient

from even_server.ratelimit import RateLimiter, client_address, ip_key
from support import batch, envelope, new_group


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


def test_client_address_takes_the_rightmost_forwarded_entry():
    headers = {"x-forwarded-for": "10.9.9.9, 198.51.100.4"}
    assert client_address("127.0.0.1", headers, "x-forwarded-for") == "198.51.100.4"
    assert client_address("127.0.0.1", {"x-forwarded-for": "garbage"}, "x-forwarded-for") == "127.0.0.1"
    assert client_address("127.0.0.1", {}, "x-forwarded-for") == "127.0.0.1"
    assert client_address("127.0.0.1", headers, None) == "127.0.0.1"


def test_limiter_forgets_idle_keys():
    clock = FakeClock()
    limiter = RateLimiter(clock)
    for n in range(50):
        limiter.check(f"192.0.2.{n}", (limiter.requests, 10))
    assert len(limiter.requests) == 50
    clock.now += 61
    limiter.check("198.51.100.1", (limiter.requests, 10))
    assert len(limiter.requests) == 1
