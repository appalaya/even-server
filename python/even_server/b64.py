"""base64url without padding (RFC 4648 section 5), strictly.

The standard library's decoders silently skip characters outside the alphabet
and accept padding; the protocol forbids both, so input is checked against the
alphabet first.
"""

import base64
import re

_ALPHABET = re.compile(r"[A-Za-z0-9_-]*")


def encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def is_b64url(text: object, length: int | None = None) -> bool:
    """True if `text` is a str of alphabet characters (and exactly `length` long)."""
    if not isinstance(text, str) or (length is not None and len(text) != length):
        return False
    return _ALPHABET.fullmatch(text) is not None


def decode(text: str) -> bytes:
    """Decode unpadded base64url. Raises ValueError on padding, characters
    outside the alphabet, or an impossible length (4k + 1)."""
    if not is_b64url(text) or len(text) % 4 == 1:
        raise ValueError("not unpadded base64url")
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def decoded_length(text: str) -> int:
    """Length `decode(text)` would return, without decoding. Raises like `decode`."""
    if not is_b64url(text) or len(text) % 4 == 1:
        raise ValueError("not unpadded base64url")
    return len(text) * 3 // 4
