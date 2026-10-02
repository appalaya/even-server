"""Configuration. Every `EVEN_*` variable is read once, at start, into a frozen
dataclass. The limit variables use the same names and defaults as the Worker
(design.md, "Limits and configuration")."""

import ipaddress
import os
import re
from collections.abc import Mapping
from dataclasses import dataclass

from .limits import Limits

type Env = Mapping[str, str]


class ConfigError(ValueError):
    pass


# (variable, Limits field, default, minimum)
LIMIT_VARIABLES: tuple[tuple[str, str, int, int], ...] = (
    ("EVEN_MAX_EVENT_BYTES", "max_event_bytes", 8192, 17),
    ("EVEN_MAX_GROUP_BYTES", "max_group_bytes", 2_097_152, 1),
    ("EVEN_MAX_GROUP_EVENTS", "max_group_events", 10_000, 1),
    ("EVEN_MAX_BATCH", "max_batch", 25, 1),
    ("EVEN_MAX_PAGE", "max_page", 500, 1),
    ("EVEN_RETENTION_DAYS", "retention_days", 365, 1),
    ("EVEN_RATE_REQUESTS_PER_MINUTE", "requests_per_minute", 120, 1),
    ("EVEN_RATE_WRITES_PER_MINUTE", "writes_per_minute", 60, 1),
    ("EVEN_RATE_GROUP_CREATES_PER_MINUTE", "group_creates_per_minute", 3, 1),
    # Units of 100 rows; 720 = 120 requests a minute, each a full page of 500
    # (6 units), so the default adds nothing to the request limit.
    ("EVEN_RATE_READS_PER_MINUTE", "reads_per_minute", 720, 1),
    # Events stored per UTC day; 0 = no budget. The default is the public server's value (design.md).
    ("EVEN_DAILY_WRITE_BUDGET", "daily_write_budget", 6500, 0),
)

# Header names are matched case-insensitively; stored lower-case.
TRUSTED_PROXY_HEADERS = {"cf-connecting-ip": "CF-Connecting-IP", "x-forwarded-for": "X-Forwarded-For"}

_DIGITS = re.compile(r"[0-9]{1,18}")


@dataclass(frozen=True, slots=True, kw_only=True)
class Config:
    limits: Limits
    db_path: str = "./even.db"
    host: str = "127.0.0.1"
    port: int = 8787
    trust_proxy_header: str | None = None  # lower-case header name, or None for the socket peer
    operator: str | None = None
    terms_url: str | None = None

    @classmethod
    def from_env(cls, env: Env = os.environ) -> Config:
        limits = Limits(**{
            field: _integer(env, name, default, minimum)
            for name, field, default, minimum in LIMIT_VARIABLES
        })
        return cls(
            limits=limits,
            db_path=_text(env, "EVEN_DB_PATH") or "./even.db",
            host=_text(env, "EVEN_HOST") or "127.0.0.1",
            port=_port(env),
            trust_proxy_header=_proxy_header(env),
            operator=_text(env, "EVEN_OPERATOR"),
            terms_url=_text(env, "EVEN_TERMS_URL"),
        )

    @property
    def listens_on_loopback(self) -> bool:
        try:
            return ipaddress.ip_address(self.host).is_loopback
        except ValueError:
            return self.host == "localhost"


def _text(env: Env, name: str) -> str | None:
    value = env.get(name, "").strip()
    return value or None


def _integer(env: Env, name: str, default: int, minimum: int) -> int:
    raw = _text(env, name)
    if raw is None:
        return default
    if not _DIGITS.fullmatch(raw):
        raise ConfigError(f"{name} must be a whole number, got {raw!r}")
    value = int(raw)
    if value < minimum:
        raise ConfigError(f"{name} must be at least {minimum}, got {value}")
    return value


def _port(env: Env) -> int:
    port = _integer(env, "EVEN_PORT", 8787, 0)
    if port > 65535:
        raise ConfigError(f"EVEN_PORT must be at most 65535, got {port}")
    return port


def _proxy_header(env: Env) -> str | None:
    raw = _text(env, "EVEN_TRUST_PROXY_HEADER")
    if raw is None:
        return None
    if raw.lower() not in TRUSTED_PROXY_HEADERS:
        allowed = " or ".join(TRUSTED_PROXY_HEADERS.values())
        raise ConfigError(f"EVEN_TRUST_PROXY_HEADER must be unset, {allowed}; got {raw!r}")
    return raw.lower()
