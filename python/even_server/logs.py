"""Logging: one JSON object per line, on stderr.

Request lines carry exactly method, route pattern, status, duration, and
whether the request was rate-limited. Never a URL, token, body, group id, or
IP (PROTOCOL.md section 9, THREAT-MODEL.md "What we log").
"""

import json
import logging
import sys
import traceback
from typing import Any

request_log = logging.getLogger("even.request")
error_log = logging.getLogger("even.error")

KNOWN_METHODS = frozenset({"GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"})


class JsonFormatter(logging.Formatter):
    """Records with a `fields` dict are written as that dict; others as
    {level, logger, message}. Tracebacks are never written: exception messages
    can carry request data."""

    def format(self, record: logging.LogRecord) -> str:
        fields: dict[str, Any] | None = getattr(record, "fields", None)
        if fields is None:
            fields = {"level": record.levelname.lower(), "logger": record.name, "message": record.getMessage()}
        return json.dumps(fields, separators=(",", ":"), default=str)


def configure(level: int = logging.INFO) -> None:
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(level)


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
