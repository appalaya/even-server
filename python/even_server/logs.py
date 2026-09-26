"""Logging: one JSON object per line, on stderr.

Request lines carry exactly method, route pattern, status, duration, and
whether the request was rate-limited. Never a URL, token, body, group id, or
IP (PROTOCOL.md section 9, THREAT-MODEL.md "What we log").
"""

import json
import logging
import re
import sys
import traceback
from typing import Any

request_log = logging.getLogger("even.request")
error_log = logging.getLogger("even.error")

KNOWN_METHODS = frozenset({"GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"})


# What identifies a group or a client, in text a library formatted itself: a
# request path, a run of 22+ base64url characters (group ids, tokens, envelope
# ids, nonces, ciphertext, epochs), and IPv4 or IPv6 addresses.
_SENSITIVE = re.compile(
    r"/v1/\S*"
    r"|[A-Za-z0-9_-]{22,}"
    r"|\b\d{1,3}(?:\.\d{1,3}){3}\b"
    r"|[0-9A-Fa-f]*:[0-9A-Fa-f]*:[0-9A-Fa-f:.%]*"
)


def scrub(text: str) -> str:
    return _SENSITIVE.sub("[redacted]", text)


class JsonFormatter(logging.Formatter):
    """The single boundary every log line passes through.

    Records with a `fields` dict (this package's own) are written as that dict.
    Any other record, from uvicorn, asyncio or another library, is written as
    {level, logger, message} where the message is the library's format string,
    never interpolated: libraries pass client addresses, request paths and
    exceptions as arguments (uvicorn's WebSocket lines do exactly that). What
    remains is scrubbed of paths, ids and addresses in case a library formatted
    it itself. Tracebacks and exception text are never written."""

    def format(self, record: logging.LogRecord) -> str:
        fields: dict[str, Any] | None = getattr(record, "fields", None)
        if fields is None:
            if record.name == "even" or record.name.startswith("even."):
                message = record.getMessage()
            else:
                message = scrub(str(record.msg))
            fields = {"level": record.levelname.lower(), "logger": record.name, "message": message}
        return json.dumps(fields, separators=(",", ":"), default=str)


def configure(level: int = logging.INFO) -> None:
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(level)
    # A handler that fails would otherwise print the record's raw message and
    # arguments to stderr, bypassing the formatter.
    logging.raiseExceptions = False
    # uvicorn keeps its access log (which records the URL) quiet only while no
    # handler is attached to it; switch the logger off instead of relying on that.
    logging.getLogger("uvicorn.access").disabled = True


def log_request(method: str, route: str | None, status: int | None, ms: float) -> None:
    """`status` is None when the client went away before any response started."""
    request_log.info("request", extra={"fields": {
        "method": method if method in KNOWN_METHODS else "OTHER",
        "route": route,
        "status": status,
        "ms": round(ms, 1),
        "limited": status == 429,
    }})


def log_exception(route: str | None, exc: BaseException) -> None:
    """Type and code location only; the message and locals stay out of the log."""
    frames = traceback.extract_tb(exc.__traceback__)
    where = [f"{frame.filename.rsplit('/', 1)[-1]}:{frame.lineno} {frame.name}" for frame in frames[-5:]]
    error_log.error("unhandled", extra={"fields": {
        "event": "unhandled_exception",
        "route": route,
        "exception": type(exc).__name__,
        "where": where,
    }})
