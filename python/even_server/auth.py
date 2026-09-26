"""Stateless membership check (PROTOCOL.md section 2).

The bearer token is 32 bytes; the group id is base64url(SHA-256(token)). The
server stores neither ahead of time and never learns anything else.
"""

import hashlib
import hmac

from . import b64
from .errors import invalid_request, unauthorized

GROUP_ID_LENGTH = 43  # base64url of 32 bytes
TOKEN_LENGTH = 43


def is_group_id(value: str) -> bool:
    return b64.is_b64url(value, GROUP_ID_LENGTH)


def group_id_for(token: bytes) -> str:
    return b64.encode(hashlib.sha256(token).digest())


def parse_bearer(header: str | None) -> bytes | None:
    """The decoded token from `Authorization: Bearer <43 chars>`, or None."""
    if not header:
        return None
    scheme, _, credentials = header.strip().partition(" ")
    token = credentials.strip(" ")
    if scheme.lower() != "bearer" or not b64.is_b64url(token, TOKEN_LENGTH):
        return None
    return b64.decode(token)


def check_group_id(group_id: str) -> None:
    if not is_group_id(group_id):
        raise invalid_request("groupId must be 43 base64url characters")


def authenticate(group_id: str, authorization: str | None) -> None:
    """Raise 401 unless the bearer token hashes to `group_id`."""
    token = parse_bearer(authorization)
    if token is None:
        raise unauthorized("missing or malformed bearer token")
    # The comparand is a public hash, so constant time is not needed; it is harmless.
    if not hmac.compare_digest(group_id_for(token), group_id):
        raise unauthorized("token does not match groupId")
