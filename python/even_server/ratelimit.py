"""Per-IP sliding-window rate limits, in memory only (design.md, "Rate limiting").

Four windows of one minute each: all requests, append requests, group
creations, and event reads. Event reads are counted in units of 100 database
rows, as the Worker counts them (`read_units`). IPv6 clients are keyed by their
/64. This is the only per-IP state the server keeps; it never touches the
database and forgets a key once its window has passed.
"""

import ipaddress
import math
import threading
import time
from collections import deque
from collections.abc import Callable, Sequence

WINDOW_SECONDS = 60.0

# Database rows per read unit: an event read costs one unit for every started
# 100 rows it reads (db.read_rows counts them as D1 does).
READ_UNIT_ROWS = 100

type Clock = Callable[[], float]


def read_units(rows: int) -> int:
    """The read limiter's charge for a read of `rows` rows: ceil(rows / 100), at least 1."""
    return max(1, math.ceil(rows / READ_UNIT_ROWS))


class SlidingWindow:
    """Timestamps of allowed events per key within the last `window` seconds."""

    def __init__(self, window: float = WINDOW_SECONDS) -> None:
        self.window = window
        self._hits: dict[str, deque[float]] = {}

    def retry_after(self, key: str, limit: int, now: float, cost: int = 1) -> int:
        """0 if `cost` more events are allowed now, else whole seconds to wait
        until enough of the oldest have left the window."""
        hits = self._hits.get(key) or deque()
        while hits and hits[0] <= now - self.window:
            hits.popleft()
        excess = len(hits) + cost - limit  # how many must leave the window first
        if excess <= 0:
            return 0
        if excess > len(hits):  # more than the whole limit; callers cap cost below this
            return math.ceil(self.window)
        return max(1, math.ceil(hits[excess - 1] + self.window - now))

    def record(self, key: str, now: float, cost: int = 1) -> None:
        self._hits.setdefault(key, deque()).extend([now] * cost)

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

    def check(self, key: str, *rules: tuple[SlidingWindow, int], cost: int = 1) -> int:
        """Count `cost` events against every (window, limit) rule, all or nothing.
        Returns 0 if allowed, else the Retry-After in seconds (nothing counted)."""
        with self._lock:
            now = self.clock()
            if now - self._last_sweep >= WINDOW_SECONDS:
                for window in (self.requests, self.writes, self.creates, self.reads):
                    window.sweep(now)
                self._last_sweep = now
            wait = max((window.retry_after(key, limit, now, cost) for window, limit in rules), default=0)
            if wait == 0:
                for window, _ in rules:
                    window.record(key, now, cost)
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


def client_address(peer: str | None, header_lines: Sequence[str]) -> str:
    """The client's address: the right-most entry of the trusted proxy header,
    read across every line of it in order, when that parses as an address;
    else the socket peer.

    One proxy is trusted: the one in front of this server, which adds the
    address it saw last, either at the end of the list or as a line of its
    own. Everything to its left, earlier lines included, came from the client
    and is forgeable. (Reading only the first line would let a client choose
    its own rate-limit key behind a proxy that appends a separate line.)"""
    entries = [entry.strip() for line in header_lines for entry in line.split(",")]
    if entries:
        try:
            ipaddress.ip_address(entries[-1])
            return entries[-1]
        except ValueError:
            pass
    return peer or "unknown"
