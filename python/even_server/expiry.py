"""Idle-group expiry (design.md, "Expiry"). Groups with no successful write for
`retention_days` are deleted with their events. Reads do not keep a group alive.

Runs in a background thread (once at start, then every 24 hours) and on demand
with `even-server expire-now` for operators who prefer cron.
"""

import logging
import threading
import time
from datetime import UTC, datetime, timedelta

from .db import Store

DAY_MS = 86_400_000
INTERVAL_SECONDS = 24 * 60 * 60
COUNTER_DAYS_KEPT = 7

log = logging.getLogger("even.expiry")


def expire_once(store: Store, now_ms: int | None = None) -> int:
    now_ms = time.time_ns() // 1_000_000 if now_ms is None else now_ms
    retention_days = store.limits().retention_days
    today = datetime.fromtimestamp(now_ms / 1000, UTC).date()
    deleted = store.expire(
        now_ms - retention_days * DAY_MS,
        counters_before=(today - timedelta(days=COUNTER_DAYS_KEPT)).isoformat(),
    )
    log.info("expiry", extra={"fields": {"event": "expiry", "groups_deleted": deleted}})
    return deleted


class ExpiryThread(threading.Thread):
    def __init__(self, store: Store, interval: float = INTERVAL_SECONDS) -> None:
        super().__init__(name="even-expiry", daemon=True)
        self.store = store
        self.interval = interval
        self._stop_event = threading.Event()

    def run(self) -> None:
        while not self._stop_event.is_set():
            try:
                expire_once(self.store)
            except Exception as exc:  # keep the thread alive; try again next interval
                log.error("expiry failed", extra={"fields": {"event": "expiry_failed", "exception": type(exc).__name__}})
            self._stop_event.wait(self.interval)

    def stop(self) -> None:
        self._stop_event.set()
