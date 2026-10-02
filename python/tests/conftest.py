import itertools
import socket
import threading
import time
from collections.abc import Callable, Iterator

import pytest
import uvicorn
from fastapi.testclient import TestClient

from even_server.app import create_app
from even_server.config import Config
from even_server.main import UVICORN_OPTIONS
from even_server.ratelimit import RateLimiter
from support import TEST_ENV

type ClientFactory = Callable[..., TestClient]


@pytest.fixture
def make_client(tmp_path) -> Iterator[ClientFactory]:
    """make_client(EVEN_MAX_BATCH=3, client=("2001:db8::1", 1), limiter=...) -> TestClient
    against a fresh database. Each app's store (one SQLite connection) is closed afterwards."""
    numbers = itertools.count()
    apps = []

    def make(*, client: tuple[str, int] = ("203.0.113.7", 50000), limiter: RateLimiter | None = None,
             **env: object) -> TestClient:
        values = {**TEST_ENV, "EVEN_DB_PATH": str(tmp_path / f"even-{next(numbers)}.db")}
        values |= {name: str(value) for name, value in env.items()}
        app = create_app(Config.from_env(values), limiter=limiter)
        apps.append(app)
        return TestClient(app, client=client)

    yield make
    for app in apps:
        app.state.store.close()


@pytest.fixture
def client(make_client) -> TestClient:
    return make_client()


@pytest.fixture
def live_server(tmp_path) -> Iterator[str]:
    """A real uvicorn on a random loopback port (TestClient is single-threaded)."""
    config = Config.from_env({**TEST_ENV, "EVEN_DB_PATH": str(tmp_path / "live.db"),
                              "EVEN_MAX_GROUP_EVENTS": "10000", "EVEN_MAX_GROUP_BYTES": "2097152"})
    app = create_app(config)
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(app, lifespan="off", **UVICORN_OPTIONS))  # as `even-server` runs it
    thread = threading.Thread(target=server.run, kwargs={"sockets": [sock]}, daemon=True)
    thread.start()
    deadline = time.monotonic() + 10
    while not server.started:
        assert time.monotonic() < deadline, "uvicorn did not start"
        time.sleep(0.02)
    yield f"http://127.0.0.1:{port}"
    server.should_exit = True
    thread.join(timeout=10)
    sock.close()
    app.state.store.close()
