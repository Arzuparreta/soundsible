"""
Two primitives every expensive lookup in the API shares: a bounded TTL cache
and single-flight.

The engine's slow paths are all yt-dlp calls — search, stream-URL resolution,
related mixes — measured in seconds. Every route that touched one grew its own
`dict[str, tuple[float, value]]`, and none of them had either of the two
properties that actually matter under real use:

- **Bounded.** A plain dict keyed by query or video id grows for the lifetime of
  the process. A long-running station accumulates every search anyone ever ran.
- **Single-flight.** A TTL cache only helps *after* the first call returns.
  While it is in flight the entry is absent, so ten clients asking for the same
  thing at once run ten yt-dlp extractions. That is exactly the shape of a user
  tapping a preview repeatedly, or of a speculative prefetch racing the click
  it was meant to make instant.

``Memo`` combines both: concurrent callers for one key collapse onto whichever
one arrived first, and everybody gets that single result.

Negative results get their own (short) TTL. An unavailable video should not be
re-resolved on every tap for the next five minutes, but it must not be written
off for as long as a success either.
"""

from __future__ import annotations

import threading
import time
from typing import Callable, Generic, Optional, TypeVar

T = TypeVar("T")

#: How long a waiter blocks on the in-flight leader before giving up and raising.
#: Generous: yt-dlp extraction with retries can legitimately take a while, and a
#: waiter that bails early would start the very duplicate work we are avoiding.
DEFAULT_WAIT_TIMEOUT_SEC = 120.0


class _Flight:
    """One in-flight computation other callers can wait on."""

    __slots__ = ("done", "value", "error")

    def __init__(self) -> None:
        self.done = threading.Event()
        self.value: object = None
        self.error: Optional[BaseException] = None


class Memo(Generic[T]):
    """Bounded TTL cache with single-flight around the miss path.

    Not an LRU: on overflow the oldest *written* entries are dropped. For
    yt-dlp results, which are only interesting while they are fresh, insertion
    order tracks usefulness closely enough and costs no bookkeeping per read.
    """

    def __init__(
        self,
        *,
        ttl_sec: float,
        maxsize: int = 512,
        negative_ttl_sec: float = 0.0,
        wait_timeout_sec: float = DEFAULT_WAIT_TIMEOUT_SEC,
    ) -> None:
        self.ttl_sec = ttl_sec
        self.negative_ttl_sec = negative_ttl_sec
        self.maxsize = max(1, maxsize)
        self.wait_timeout_sec = wait_timeout_sec
        self._lock = threading.Lock()
        self._entries: dict[str, tuple[float, T]] = {}
        self._flights: dict[str, _Flight] = {}

    # ── Cache surface ────────────────────────────────────────────────────────

    def get(self, key: str) -> Optional[T]:
        """Return the live value for `key`, or None when absent/expired."""
        now = time.time()
        with self._lock:
            entry = self._entries.get(key)
            if entry is None:
                return None
            if entry[0] <= now:
                self._entries.pop(key, None)
                return None
            return entry[1]

    def put(self, key: str, value: T, *, ttl_sec: Optional[float] = None) -> None:
        """Store `value`, using the negative TTL for falsy values when set."""
        if ttl_sec is None:
            ttl_sec = (
                self.negative_ttl_sec
                if (self.negative_ttl_sec > 0 and not value)
                else self.ttl_sec
            )
        if ttl_sec <= 0:
            return
        with self._lock:
            self._entries[key] = (time.time() + ttl_sec, value)
            self._prune_locked()

    def invalidate(self, key: str) -> None:
        with self._lock:
            self._entries.pop(key, None)

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()

    def __len__(self) -> int:
        with self._lock:
            return len(self._entries)

    def _prune_locked(self) -> None:
        if len(self._entries) <= self.maxsize:
            return
        now = time.time()
        for key in [k for k, (expires, _) in self._entries.items() if expires <= now]:
            self._entries.pop(key, None)
        # Still over budget: drop oldest insertions (dicts keep insertion order).
        overflow = len(self._entries) - self.maxsize
        if overflow > 0:
            for key in list(self._entries)[:overflow]:
                self._entries.pop(key, None)

    # ── Single-flight surface ────────────────────────────────────────────────

    def resolve(self, key: str, compute: Callable[[], T]) -> T:
        """Return the cached value for `key`, computing it at most once.

        A cache hit returns immediately. On a miss the first caller runs
        `compute` while every concurrent caller for the same key waits for that
        one result — including the exception, if it raises.
        """
        cached = self.get(key)
        if cached is not None:
            return cached

        with self._lock:
            flight = self._flights.get(key)
            leader = flight is None
            if leader:
                flight = _Flight()
                self._flights[key] = flight

        assert flight is not None
        if not leader:
            if not flight.done.wait(self.wait_timeout_sec):
                raise TimeoutError(f"timed out waiting for in-flight resolution of {key!r}")
            if flight.error is not None:
                raise flight.error
            return flight.value  # type: ignore[return-value]

        try:
            value = compute()
        except BaseException as exc:  # noqa: BLE001 — re-raised after fan-out
            flight.error = exc
            with self._lock:
                self._flights.pop(key, None)
            flight.done.set()
            raise
        else:
            self.put(key, value)
            flight.value = value
            with self._lock:
                self._flights.pop(key, None)
            flight.done.set()
            return value
