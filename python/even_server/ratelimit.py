"""Per-IP sliding-window rate limits, in memory only (design.md, "Rate limiting").

Four windows of one minute each: all requests, append requests, group
creations, and event reads. IPv6 clients are keyed by their /64. This is the only per-IP state
the server keeps; it never touches the database and forgets a key once its
window has passed.
"""

import ipaddress
import math
import threading
import time
from collections import deque
from collections.abc import Callable, Mapping

WINDOW_SECONDS = 60.0

type Clock = Callable[[], float]


class SlidingWindow:
    """Timestamps of allowed events per key within the last `window` seconds."""

    def __init__(self, window: float = WINDOW_SECONDS) -> None:
        self.window = window
        self._hits: dict[str, deque[float]] = {}

    def retry_after(self, key: str, limit: int, now: float) -> int:
        """0 if one more event is allowed now, else whole seconds to wait."""
        hits = self._hits.get(key)
        if hits is None:
            return 0
        while hits and hits[0] <= now - self.window:
            hits.popleft()
        if len(hits) < limit:
            return 0
        return max(1, math.ceil(hits[0] + self.window - now))

    def record(self, key: str, now: float) -> None:
        self._hits.setdefault(key, deque()).append(now)

    def sweep(self, now: float) -> None:
        for key in [k for k, hits in self._hits.items() if not hits or hits[-1] <= now - self.window]:
            del self._hits[key]

    def __len__(self) -> int:
        return len(self._hits)


class RateLimiter:
    def __init__(self, clock: Clock = time.monotonic) -> None:
        self.clock = clock
        self.requests = SlidingWindow()
        self.writes = SlidingWindow()
        self.creates = SlidingWindow()
        self.reads = SlidingWindow()
        self._lock = threading.Lock()
        self._last_sweep = clock()

    def check(self, key: str, *rules: tuple[SlidingWindow, int]) -> int:
        """Count one event against every (window, limit) rule, all or nothing.
        Returns 0 if allowed, else the Retry-After in seconds (nothing counted)."""
        with self._lock:
            now = self.clock()
            if now - self._last_sweep >= WINDOW_SECONDS:
                for window in (self.requests, self.writes, self.creates, self.reads):
                    window.sweep(now)
                self._last_sweep = now
            wait = max((window.retry_after(key, limit, now) for window, limit in rules), default=0)
            if wait == 0:
                for window, _ in rules:
                    window.record(key, now)
            return wait


def ip_key(address: str) -> str:
    """Rate-limit key for an address: IPv4 as is, IPv6 by /64, IPv4-mapped IPv6
    as the IPv4 address. Anything unparseable is used verbatim."""
    try:
        ip = ipaddress.ip_address(address.strip())
    except ValueError:
        return address
    if isinstance(ip, ipaddress.IPv6Address):
        if ip.ipv4_mapped is not None:
            return str(ip.ipv4_mapped)
        prefix = int(ip) >> 64 << 64
        return f"{ipaddress.IPv6Address(prefix)}/64"
    return str(ip)


def client_address(peer: str | None, headers: Mapping[str, str], trusted_header: str | None) -> str:
    """The client's address: from the configured proxy header when present and
    parseable, else the socket peer. For X-Forwarded-For the right-most entry is
    used, which is the one the nearest (trusted) proxy appended; entries to its
    left are client-supplied and forgeable."""
    if trusted_header:
        raw = headers.get(trusted_header)
        if raw:
            candidate = raw.rsplit(",", 1)[-1].strip()
            try:
                ipaddress.ip_address(candidate)
                return candidate
            except ValueError:
                pass
    return peer or "unknown"
