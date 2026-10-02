"""Helpers shared by the tests: groups, envelopes, and a test configuration."""

import base64
import hashlib
import secrets
from dataclasses import dataclass
from typing import Any

# Small caps as the conformance suite requires; rates high enough not to interfere.
TEST_ENV = {
    "EVEN_MAX_GROUP_BYTES": "65536",
    "EVEN_MAX_GROUP_EVENTS": "200",
    "EVEN_RATE_REQUESTS_PER_MINUTE": "100000",
    "EVEN_RATE_WRITES_PER_MINUTE": "100000",
    "EVEN_RATE_GROUP_CREATES_PER_MINUTE": "100000",
    "EVEN_RATE_READS_PER_MINUTE": "100000",
    "EVEN_DAILY_WRITE_BUDGET": "0",
}


def b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


@dataclass(frozen=True)
class Group:
    token: str
    id: str

    @property
    def headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.token}"}

    @property
    def events(self) -> str:
        return f"/v1/groups/{self.id}/events"

    @property
    def path(self) -> str:
        return f"/v1/groups/{self.id}"

    @property
    def subscriptions(self) -> str:
        return f"/v1/groups/{self.id}/subscriptions"


def new_group() -> Group:
    """Like a client: 32 random token bytes; group id = base64url(sha256(token))."""
    token = secrets.token_bytes(32)
    return Group(token=b64(token), id=b64(hashlib.sha256(token).digest()))


def envelope(*, size: int = 256, v: Any = 1, id: str | None = None) -> dict[str, Any]:
    return {
        "id": id or b64(secrets.token_bytes(16)),
        "v": v,
        "n": b64(secrets.token_bytes(24)),
        "c": b64(secrets.token_bytes(size)),
    }


def batch(*envelopes: dict[str, Any]) -> dict[str, Any]:
    return {"events": list(envelopes)}


def read_all(client: Any, group: Group) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    since = 0
    while True:
        body = client.get(group.events, params={"since": since}, headers=group.headers).json()
        events += body["events"]
        since = body["next"]
        if not body["more"]:
            return events
