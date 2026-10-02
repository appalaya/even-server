import json
import logging
import socket
from urllib.parse import urlsplit

import pytest

from even_server.logs import JsonFormatter
from support import batch, envelope, new_group

ERROR_KEYS = {"error", "message", "index", "reason"}


def test_subscriptions_authenticate_then_501(client):
    group = new_group()
    assert client.put(group.subscriptions, headers=new_group().headers).status_code == 401
    assert client.put(group.subscriptions).status_code == 401
    response = client.put(group.subscriptions, headers=group.headers, json={"token": "x"})
    assert response.status_code == 501
    assert response.json()["error"] == "not_implemented"
    assert client.get("/v1/info").json()["push"] is False


@pytest.mark.parametrize("path", ["/", "/v1", "/v2/info", "/v1/info/", "/v1/groups", "/docs", "/openapi.json",
                                  f"/v1/groups/{'A' * 43}/events/", f"/v1/groups/{'A' * 43}/other"])
def test_unknown_route_is_404(client, path):
    response = client.get(path)
    assert response.status_code == 404
    assert response.json() == {"error": "not_found"}


@pytest.mark.parametrize(("method", "path", "allow"), [
    ("POST", "/v1/info", "GET"),
    ("DELETE", "/v1/info", "GET"),
    ("PUT", "/v1/groups/{g}/events", "GET, POST"),
    ("PATCH", "/v1/groups/{g}/events", "GET, POST"),
    ("DELETE", "/v1/groups/{g}/events", "GET, POST"),
    ("GET", "/v1/groups/{g}", "DELETE"),
    ("POST", "/v1/groups/{g}", "DELETE"),
    ("GET", "/v1/groups/{g}/subscriptions", "PUT"),
    ("DELETE", "/v1/groups/{g}/subscriptions", "PUT"),
])
def test_wrong_method_is_405(client, method, path, allow):
    response = client.request(method, path.format(g=new_group().id))
    assert response.status_code == 405
    assert response.json() == {"error": "method_not_allowed"}
    assert response.headers["allow"] == allow


def test_every_response_is_no_store_and_every_error_is_protocol_shaped(make_client):
    client = make_client(EVEN_MAX_GROUP_EVENTS=1, EVEN_DAILY_WRITE_BUDGET=2)
    group = new_group()
    first = envelope()
    responses = [
        client.get("/v1/info"),                                                           # 200
        client.post(group.events, json=batch(first), headers=group.headers),             # 200, 1 event counted
        client.get(group.events, headers=group.headers),                                  # 200
        client.post(group.events, json=batch(envelope()), headers=group.headers),       # 413
        client.post(group.events, json=batch({}), headers=group.headers),               # 400 envelope
        client.post(group.events, json=batch(envelope(v=2)), headers=group.headers),    # 415
        client.post(group.events, content=b"x", headers=group.headers),                 # 400 request
        client.get("/v1/groups/short/events"),                                            # 400
        client.get(group.events),                                                         # 401
        client.get("/nope"),                                                              # 404
        client.post("/v1/info"),                                                          # 405
        client.put(group.subscriptions, headers=group.headers),                           # 501
        client.post(group.events, json=batch(first), headers=group.headers),             # 200, a duplicate: 0 counted
        client.post(group.events, json=batch(envelope(), envelope()), headers=group.headers),  # 503: 1 + 2 > 2
        client.delete(group.path, headers=group.headers),                                 # 204
    ]
    client.app.state.store.block(group.id, 0)
    responses.append(client.get(group.events, headers=group.headers))                     # 410
    statuses = [r.status_code for r in responses]
    assert statuses == [200, 200, 200, 413, 400, 415, 400, 400, 401, 404, 405, 501, 200, 503, 204, 410]
    for response in responses:
        assert response.headers["cache-control"] == "no-store", response.status_code
        if response.status_code >= 400:
            body = response.json()
            assert set(body) <= ERROR_KEYS and isinstance(body["error"], str), body
            assert response.headers["content-type"] == "application/json; charset=utf-8"


def _server_records(caplog):
    """Records from the server's loggers (the test client's own httpx logger is not the server)."""
    return [r for r in caplog.records if r.name.startswith(("even", "uvicorn"))]


def _written(caplog) -> str:
    """Exactly what the server would write to its log."""
    formatter = JsonFormatter()
    return "\n".join(formatter.format(r) for r in _server_records(caplog))


def _request_lines(caplog):
    return [record.fields for record in caplog.records if record.name == "even.request"]


def test_one_log_line_per_request_without_urls_tokens_or_ips(make_client, caplog):
    caplog.set_level(logging.INFO)
    client = make_client(client=("198.51.100.23", 4444))
    group = new_group()
    client.post(group.events, json=batch(envelope()), headers=group.headers)
    client.get(group.events, params={"since": 0}, headers=group.headers)
    client.get("/nothing-here")

    lines = _request_lines(caplog)
    assert [(l["method"], l["route"], l["status"]) for l in lines] == [
        ("POST", "/v1/groups/{groupId}/events", 200),
        ("GET", "/v1/groups/{groupId}/events", 200),
        ("GET", None, 404),
    ]
    for line in lines:
        assert set(line) == {"method", "route", "status", "ms", "limited"}
        assert line["limited"] is False
    written = _written(caplog)
    assert len(written.splitlines()) == 3
    for secret in (group.id, group.token, "198.51.100.23", "since", "testserver"):
        assert secret not in written


def test_unhandled_error_is_500_and_logs_only_the_exception_type(client, caplog, monkeypatch):
    caplog.set_level(logging.INFO)
    group = new_group()

    def explode(*args, **kwargs):
        raise RuntimeError(f"boom {group.id}")

    monkeypatch.setattr(client.app.state.store, "read", explode)
    response = client.get(group.events, headers=group.headers)
    assert response.status_code == 500
    assert response.json() == {"error": "server_error"}
    assert response.headers["cache-control"] == "no-store"
    errors = [r.fields for r in caplog.records if r.name == "even.error"]
    assert errors and errors[0]["exception"] == "RuntimeError"
    assert group.id not in _written(caplog)
    assert "boom" not in _written(caplog)
    assert _request_lines(caplog)[-1]["status"] == 500


def test_library_log_records_are_never_interpolated_and_are_scrubbed():
    """uvicorn logs WebSocket handshakes as '%s - "WebSocket %s" 403' with the
    client address and the full path as arguments; a library may also format a
    message itself. Neither may reach the log."""
    group = new_group()
    formatter = JsonFormatter()
    handshake = logging.LogRecord("uvicorn.error", logging.INFO, "x.py", 1, '%s - "WebSocket %s" 403',
                                  ("198.51.100.23:4444", f"{group.events}?since=0"), None)
    line = json.loads(formatter.format(handshake))
    assert line == {"level": "info", "logger": "uvicorn.error", "message": '%s - "WebSocket %s" 403'}

    preformatted = (f"Task exception: GET {group.events} from 198.51.100.23 or [2001:db8::7]:443 "
                    f"token={group.token} id={group.id} and {envelope()['c']}")
    record = logging.LogRecord("asyncio", logging.ERROR, "x.py", 1, preformatted, None,
                               (RuntimeError, RuntimeError(group.id), None))
    written = formatter.format(record)
    for secret in (group.id, group.token, "/v1/groups", "198.51.100.23", "2001:db8::7", "RuntimeError"):
        assert secret not in written
    assert json.loads(written)["message"].startswith("Task exception: GET [redacted] from [redacted]")


def _raw_request(url: str, request: bytes) -> bytes:
    parts = urlsplit(url)
    with socket.create_connection((parts.hostname, parts.port), timeout=5) as conn:
        conn.sendall(request)
        response = b""
        while b"\r\n" not in response and (chunk := conn.recv(65536)):
            response += chunk
    return response.split(b"\r\n", 1)[0]  # the status line


def test_nothing_uvicorn_logs_for_odd_requests_names_the_group_or_client(live_server, caplog):
    """Against uvicorn configured exactly as `even-server` runs it: a WebSocket
    upgrade (which uvicorn would log with address and URL), a malformed request
    line and a malformed header, each carrying a group id and token."""
    caplog.set_level(logging.DEBUG)
    group = new_group()
    auth = f"Authorization: Bearer {group.token}\r\n"
    upgrade = _raw_request(live_server, (
        f"GET {group.events}?since=0 HTTP/1.1\r\nHost: x\r\n{auth}Connection: Upgrade\r\nUpgrade: websocket\r\n"
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
    assert upgrade.startswith(b"HTTP/1.1 200")  # served as a plain read, never upgraded
    _raw_request(live_server, f"GET {group.events} HTTP/1.1 junk\r\nHost: x\r\n\r\n".encode())
    _raw_request(live_server, f"GET {group.events} HTTP/1.1\r\nHost: x\r\nBad Header: {group.token}\r\n\r\n".encode())

    records = [r for r in caplog.records if not r.name.startswith(("httpx", "httpcore"))]
    assert records, "the server logged nothing at all"
    # ws="none": uvicorn never produces its '<address> - "WebSocket <path>" 403' line.
    assert not any('"WebSocket ' in r.getMessage() for r in records)
    # pytest attaches its capture handler to non-propagating loggers, which re-enables uvicorn's access log here
    # (`even-server` disables that logger outright). Its URL-bearing record must still not survive the formatter.
    written = "\n".join(JsonFormatter().format(r) for r in records)
    for secret in (group.id, group.token, group.events, "127.0.0.1"):
        assert secret not in written
