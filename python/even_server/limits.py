"""The published limits, and the `/v1/info` document built from them.

Every limit the server enforces is a field here. At start the values from the
environment are written to the `limits` table; everything that enforces or
publishes a limit reads it back from that table, so what `/v1/info` says and
what the server does cannot drift (PROTOCOL.md section 6.1).
"""

import math
from collections.abc import Iterable
from dataclasses import dataclass, fields
from typing import Any

PROTOCOL_VERSIONS = (1,)


class LimitsMissing(RuntimeError):
    """A limit row is missing from the table. Fail closed: refuse to serve."""


@dataclass(frozen=True, slots=True, kw_only=True)
class Limits:
    max_event_bytes: int
    max_group_bytes: int
    max_group_events: int
    max_batch: int
    max_page: int
    daily_write_budget: int
    requests_per_minute: int
    writes_per_minute: int
    group_creates_per_minute: int
    reads_per_minute: int
    retention_days: int

    def rows(self) -> list[tuple[str, int]]:
        """(key, value) pairs for the `limits` table."""
        return [(f.name, getattr(self, f.name)) for f in fields(self)]

    @classmethod
    def from_rows(cls, rows: Iterable[tuple[str, int]]) -> Limits:
        """Every limit from the table. A row that is missing, or is not a
        non-negative integer, fails closed, as in the Worker."""
        values = dict(rows)
        missing = [f.name for f in fields(cls)
                   if type(values.get(f.name)) is not int or values[f.name] < 0]
        if missing:
            raise LimitsMissing(f"limits table is missing or invalid: {', '.join(missing)}")
        return cls(**{f.name: values[f.name] for f in fields(cls)})

    @property
    def max_body_bytes(self) -> int:
        """Upper bound on an append body we are willing to buffer.

        Derived from published limits, never tighter than they imply: a full
        batch of maximum-size envelopes is roughly half this. Anything larger
        necessarily breaks `max_batch` or `max_event_bytes`, so it is answered
        with `invalid_request` without being read to the end.
        """
        per_envelope = 4 * math.ceil(self.max_event_bytes / 3) + 256
        return max(1 << 20, 2 * self.max_batch * per_envelope)


def info_document(limits: Limits, *, operator: str | None, terms: str | None) -> dict[str, Any]:
    """The `/v1/info` body (PROTOCOL.md section 6.1)."""
    doc: dict[str, Any] = {
        "protocol": list(PROTOCOL_VERSIONS),
        "limits": {
            "max_event_bytes": limits.max_event_bytes,
            "max_group_bytes": limits.max_group_bytes,
            "max_group_events": limits.max_group_events,
            "max_batch": limits.max_batch,
            "max_page": limits.max_page,
            "daily_write_budget": limits.daily_write_budget,
            "rate": {
                "requests_per_minute": limits.requests_per_minute,
                "writes_per_minute": limits.writes_per_minute,
                "group_creates_per_minute": limits.group_creates_per_minute,
                "reads_per_minute": limits.reads_per_minute,
            },
        },
        "retention_days": limits.retention_days,
        "push": False,
    }
    if operator:
        doc["operator"] = operator
    if terms:
        doc["terms"] = terms
    return doc
