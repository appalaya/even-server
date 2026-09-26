"""Append-body parsing and envelope validation (PROTOCOL.md sections 4 and 6.2).

Order: request shape (`invalid_request`), then every envelope structurally in
array order (first offender -> `400 invalid_envelope` with `index`), then
versions (first offender -> `415 unsupported_version` with `index`). A 400
anywhere in the batch wins over a 415 anywhere in the batch.
"""

import json
import math
from dataclasses import dataclass
from typing import Any

from . import b64
from .errors import ApiError, invalid_request
from .limits import Limits

SUPPORTED_VERSIONS = frozenset({1})
ENVELOPE_KEYS = frozenset({"id", "v", "n", "c"})
ID_LENGTH = 22     # base64url of 16 random bytes
NONCE_LENGTH = 32  # base64url of 24 bytes
MIN_CIPHERTEXT = 17
STORED_OVERHEAD = 64  # stored size = decoded length of c + 64


@dataclass(frozen=True, slots=True)
class Envelope:
    id: str
    v: int
    n: str
    c: str
    size: int  # stored size for cap accounting


class _Malformed(Exception):
    pass


def _reject_constant(name: str) -> Any:
    raise ValueError(f"{name} is not JSON")


def parse_append_body(body: bytes, limits: Limits) -> list[Envelope]:
    """Validate an append body. Returns every envelope in request order
    (in-request duplicates included; see `first_occurrences`)."""
    try:
        document = json.loads(body.decode("utf-8"), parse_constant=_reject_constant)
    except (UnicodeDecodeError, ValueError, RecursionError):
        raise invalid_request("body is not a JSON document") from None
    if not isinstance(document, dict) or not isinstance(events := document.get("events"), list):
        raise invalid_request('body must be {"events": [ ... ]}')
    if not 1 <= len(events) <= limits.max_batch:
        raise invalid_request(f"events must hold 1 to {limits.max_batch} envelopes")

    envelopes: list[Envelope] = []
    for index, raw in enumerate(events):
        try:
            envelopes.append(_structural(raw, limits.max_event_bytes))
        except _Malformed as exc:
            raise ApiError(400, "invalid_envelope", str(exc), index=index) from None
    for index, envelope in enumerate(envelopes):
        if envelope.v not in SUPPORTED_VERSIONS:
            raise ApiError(415, "unsupported_version",
                           f"envelope version {envelope.v} is not supported", index=index)
    return envelopes


def first_occurrences(envelopes: list[Envelope]) -> list[Envelope]:
    """Collapse ids repeated within one request to their first occurrence."""
    seen: set[str] = set()
    unique = []
    for envelope in envelopes:
        if envelope.id not in seen:
            seen.add(envelope.id)
            unique.append(envelope)
    return unique


def _structural(raw: object, max_event_bytes: int) -> Envelope:
    if not isinstance(raw, dict):
        raise _Malformed("envelope must be an object")
    if raw.keys() != ENVELOPE_KEYS:
        raise _Malformed("envelope must have exactly the fields id, v, n, c")
    id_, v, n, c = raw["id"], raw["v"], raw["n"], raw["c"]
    if not b64.is_b64url(id_, ID_LENGTH):
        raise _Malformed(f"id must be {ID_LENGTH} base64url characters")
    version = _integer(v)
    if version is None:
        raise _Malformed("v must be an integer")
    if not b64.is_b64url(n, NONCE_LENGTH):
        raise _Malformed(f"n must be {NONCE_LENGTH} base64url characters")
    if not isinstance(c, str):
        raise _Malformed("c must be a string")
    # Cheap bound before decoding anything: 4 characters carry 3 bytes.
    if len(c) > 4 * math.ceil(max_event_bytes / 3):
        raise _Malformed(f"c decodes to more than {max_event_bytes} bytes")
    try:
        length = len(b64.decode(c))
    except ValueError:
        raise _Malformed("c must be unpadded base64url") from None
    if not MIN_CIPHERTEXT <= length <= max_event_bytes:
        raise _Malformed(f"c must decode to {MIN_CIPHERTEXT}..{max_event_bytes} bytes")
    return Envelope(id=id_, v=version, n=n, c=c, size=length + STORED_OVERHEAD)


def _integer(value: object) -> int | None:
    """JSON integer -> int. Booleans are not integers. An integral float such as
    `1.0` is the same JSON number as `1` (it is to every JavaScript client), so
    it is accepted and normalised."""
    match value:
        case bool():
            return None
        case int():
            return value
        case float() if math.isfinite(value) and value.is_integer():
            return int(value)
        case _:
            return None
