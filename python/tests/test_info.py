import sqlite3

from support import batch, envelope, new_group


def test_info_shape_matches_configuration(make_client):
    client = make_client(EVEN_MAX_BATCH=7, EVEN_DAILY_WRITE_BUDGET=900, EVEN_RETENTION_DAYS=30,
                         EVEN_RATE_REQUESTS_PER_MINUTE=500)
    response = client.get("/v1/info")
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/json; charset=utf-8"
    assert response.json() == {
        "protocol": [1],
        "limits": {
            "max_event_bytes": 8192,
            "max_group_bytes": 65536,
            "max_group_events": 200,
            "max_batch": 7,
            "max_page": 500,
            "daily_write_budget": 900,
            "rate": {
                "requests_per_minute": 500,
                "writes_per_minute": 100000,
                "group_creates_per_minute": 100000,
            },
        },
        "retention_days": 30,
        "push": False,
    }


def test_operator_and_terms_are_published_when_set(make_client):
    body = make_client(EVEN_OPERATOR="Maya's Pi", EVEN_TERMS_URL="https://example.net/terms").get("/v1/info").json()
    assert body["operator"] == "Maya's Pi"
    assert body["terms"] == "https://example.net/terms"


def test_info_and_enforcement_are_both_read_from_the_limits_table(client):
    with sqlite3.connect(client.app.state.store.path) as db:
        db.execute("UPDATE limits SET value = 2 WHERE key = 'max_batch'")
    assert client.get("/v1/info").json()["limits"]["max_batch"] == 2
    group = new_group()
    response = client.post(group.events, json=batch(envelope(), envelope(), envelope()), headers=group.headers)
    assert response.status_code == 400
    assert response.json()["error"] == "invalid_request"


def test_limits_table_is_seeded_on_start(client):
    with sqlite3.connect(client.app.state.store.path) as db:
        rows = dict(db.execute("SELECT key, value FROM limits"))
    assert rows == {
        "max_event_bytes": 8192, "max_group_bytes": 65536, "max_group_events": 200, "max_batch": 25,
        "max_page": 500, "daily_write_budget": 0, "requests_per_minute": 100000,
        "writes_per_minute": 100000, "group_creates_per_minute": 100000, "retention_days": 365,
    }
