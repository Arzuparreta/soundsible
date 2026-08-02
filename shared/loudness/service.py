"""Idle worker that measures the library's loudness, once per file, forever.

Shaped after :mod:`shared.lossless.service`: one daemon thread that only works
while nothing else on the instance is, so a full sweep of a large library is
invisible to whoever is listening.

The order it works in is the part that matters most to how the feature feels.
Sweeping a library alphabetically means levelling arrives an hour after install;
sweeping favourites first, then the most recently added, means the music
somebody actually plays is levelled within the first couple of minutes and the
long tail finishes quietly overnight.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from collections.abc import Iterable
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable

from shared.path_resolver import resolve_local_track_path

from .measure import measure_loudness
from .store import LoudnessStore, identity_for, source_stamp

logger = logging.getLogger(__name__)

#: How long the instance must have been quiet before a sweep starts.
QUIET_SECONDS = 60
#: A breather between files so a sweep never monopolises the disk queue.
FILE_SLEEP_SEC = 0.1
#: How often the library is re-read looking for new or changed files.
INVENTORY_INTERVAL_SEC = 3600
#: A file still being written has a moving size and mtime; measuring it would
#: only invalidate itself a second later.
MIN_FILE_AGE_SEC = 10
#: Clients refetch the whole library when told measurements changed, so this is
#: deliberately rare: the sweep is background work, not news.
NOTIFY_INTERVAL_SEC = 300
#: How many files one pass takes before re-checking whether to yield.
BATCH = 24


def loudness_analysis_enabled() -> bool:
    """Instance kill switch for the measuring pass.

    Turning this off stops new measurements; it does not turn levelling off.
    Whatever has already been measured keeps working, because the numbers are
    already stored and the player applies them without asking the engine.
    """
    raw = os.getenv("SOUNDSIBLE_LOUDNESS_ANALYSIS")
    if raw is None:
        return True
    return raw.strip().casefold() not in {"0", "false", "no", "off"}


class LoudnessService:
    def __init__(
        self,
        *,
        store: LoudnessStore | None = None,
        foreground_busy: Callable[[], bool] | None = None,
        inventory: Callable[[], Iterable[tuple[Any, str]]] | None = None,
        measure: Callable[..., Any] | None = None,
        quiet_seconds: int = QUIET_SECONDS,
        notify: Callable[[], None] | None = None,
    ):
        self.store = store or LoudnessStore()
        self._foreground_busy = foreground_busy or self._default_foreground_busy
        self._inventory = inventory or self._default_inventory
        self._measure = measure or measure_loudness
        self._notify = notify or self._default_notify
        self.quiet_seconds = max(0, int(quiet_seconds))
        self._stop = threading.Event()
        self._wake = threading.Event()
        self._thread: threading.Thread | None = None
        self._quiet_since: float | None = None
        self._last_inventory_at: float | None = None
        self._last_notify_at: float = 0.0
        self._activity_lock = threading.Lock()
        self._activity = "stopped"
        # Work the listener is waiting on: tracks about to be played that nobody
        # has measured yet. Jumps the whole sweep and ignores the idle gate,
        # because it is bounded to a handful of files and finishes in a second.
        self._priority: list[tuple[str, str]] = []
        self._queue: list[tuple[str, str]] = []
        self._measured_since_notify = 0

    # ----- lifecycle -----

    def start(self) -> bool:
        if self._thread and self._thread.is_alive():
            return False
        if not loudness_analysis_enabled():
            logger.info("Loudness: analysis disabled by environment")
            return False
        self._stop.clear()
        self._wake.clear()
        self._thread = threading.Thread(target=self._run, name="loudness-idle", daemon=True)
        self._thread.start()
        return True

    def stop(self, timeout: float = 3.0) -> None:
        self._stop.set()
        self._wake.set()
        thread = self._thread
        if thread and thread.is_alive():
            thread.join(timeout=timeout)
        self._thread = None
        self._set_activity("stopped")

    def wake(self) -> None:
        self._wake.set()

    # ----- public work intake -----

    def request(self, identities: Iterable[str]) -> None:
        """Measure these next, ahead of the sweep.

        Called when the player is about to reach a track nobody has measured.
        The result never touches the track that is already sounding — the player
        refuses to re-level a playing deck — so this is about the *next* few
        songs being right rather than rescuing the current one.
        """
        wanted = {str(i) for i in identities if i}
        if not wanted:
            return
        for track, path in self._inventory():
            identity = identity_for(track)
            if identity not in wanted:
                continue
            stamp = self._stamp(path)
            if stamp and not self.store.is_current(identity, stamp):
                self._priority.append((identity, path))
        if self._priority:
            self.wake()

    def measure_now(self, track_id: str) -> None:
        """Measure one track immediately — a download that just finished.

        Synchronous and bounded: one file is well under a second, and doing it
        here means a freshly downloaded song is levelled the first time it
        plays rather than after the next sweep.
        """
        if not loudness_analysis_enabled():
            return
        try:
            for track, path in self._inventory():
                if track.id != track_id and identity_for(track) != track_id:
                    continue
                self._measure_one(identity_for(track), path)
                return
        except Exception:
            logger.debug("Loudness: immediate measurement failed for %s", track_id, exc_info=True)

    def invalidate(self, identity: str) -> None:
        """Forget a measurement because the bytes behind it changed."""
        try:
            self.store.forget(identity)
        except Exception:
            logger.debug("Loudness: could not invalidate %s", identity, exc_info=True)

    def status(self) -> dict[str, Any]:
        with self._activity_lock:
            activity = self._activity
        coverage = self.store.coverage()
        return {
            "enabled": loudness_analysis_enabled(),
            "activity": activity,
            "pending": len(self._queue) + len(self._priority),
            **coverage,
        }

    # ----- the loop -----

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                worked = self.run_once()
            except Exception:
                logger.exception("Loudness sweep iteration failed")
                worked = False
            self._wake.wait(timeout=2 if worked else 15)
            self._wake.clear()

    def run_once(self) -> bool:
        """One pass. Returns whether anything was measured."""
        if not loudness_analysis_enabled():
            self._set_activity("disabled")
            return False

        # Priority work is what a listener is waiting on, so it ignores the idle
        # gate: a handful of files, measured now, is worth more than a perfectly
        # quiet disk.
        if self._priority:
            batch, self._priority = self._priority[:BATCH], self._priority[BATCH:]
            return self._measure_batch(batch, "priority")

        if self._foreground_busy():
            self._quiet_since = None
            self._set_activity("waiting")
            return False
        now = time.monotonic()
        if self._quiet_since is None:
            self._quiet_since = now
        if now - self._quiet_since < self.quiet_seconds:
            self._set_activity("waiting")
            return False

        if not self._queue:
            if self._last_inventory_at and now - self._last_inventory_at < INVENTORY_INTERVAL_SEC:
                self._set_activity("idle")
                return False
            self._refresh_queue()
            self._last_inventory_at = now
            if not self._queue:
                self._set_activity("idle")
                return False

        batch, self._queue = self._queue[:BATCH], self._queue[BATCH:]
        return self._measure_batch(batch, "sweeping")

    def _measure_batch(self, batch: list[tuple[str, str]], activity: str) -> bool:
        if not batch:
            return False
        self._set_activity(activity)
        workers = self._worker_count()
        if workers <= 1:
            for identity, path in batch:
                if self._stop.is_set():
                    break
                self._measure_one(identity, path)
                if FILE_SLEEP_SEC:
                    self._stop.wait(FILE_SLEEP_SEC)
        else:
            with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="loudness") as pool:
                list(pool.map(lambda item: self._measure_one(*item), batch))
        self._maybe_notify()
        return True

    def _measure_one(self, identity: str, path: str) -> None:
        if not identity:
            return
        stamp = self._stamp(path)
        if not stamp or self.store.is_current(identity, stamp):
            return
        try:
            result = self._measure(path)
        except Exception:
            # The attempt failed, not the audio. Back off and come back to it,
            # rather than concluding this file has no loudness.
            logger.debug("Loudness: could not measure %s", path, exc_info=True)
            self.store.mark_failed(identity, stamp)
            return
        # A `None` result here means the file was read and genuinely has nothing
        # to measure. That is a verdict worth storing, so the sweep stops
        # reopening it.
        self.store.put(identity, stamp, result)
        self._measured_since_notify += 1

    def _refresh_queue(self) -> None:
        candidates: list[tuple[str, str]] = []
        stamps: list[tuple[str, str]] = []
        for track, path in self._ordered_inventory():
            if self._stop.is_set():
                return
            stamp = self._stamp(path)
            if not stamp:
                continue
            candidates.append((identity_for(track), path))
            stamps.append((identity_for(track), stamp))
        wanted = set(self.store.pending(stamps))
        self._queue = [(identity, path) for identity, path in candidates if identity in wanted]

    def _ordered_inventory(self) -> list[tuple[Any, str]]:
        """The library, favourites first, then most recently added."""
        items = list(self._inventory())
        try:
            favourites = self._favourite_ids()
        except Exception:
            return items
        if not favourites:
            return items
        rank = {track_id: index for index, track_id in enumerate(favourites)}
        return sorted(items, key=lambda item: rank.get(getattr(item[0], "id", ""), len(rank)))

    def _stamp(self, path: str) -> str | None:
        from pathlib import Path

        try:
            source = Path(path)
            stat = source.stat()
        except OSError:
            return None
        # Still being written: its size and mtime are moving, and a measurement
        # taken now would invalidate itself a second later.
        if time.time() - (stat.st_mtime_ns / 1e9) < MIN_FILE_AGE_SEC:
            return None
        return source_stamp(source)

    def _worker_count(self) -> int:
        """One worker on a spinning disk, a few on an SSD.

        The sweep is I/O bound, not CPU bound: the meter runs at several hundred
        times realtime, and what actually costs is reading the library off the
        disk once. Parallel reads on a rotational disk turn a sequential pass
        into a seek storm, which is the one thing that would be felt.
        """
        try:
            from shared.api import orchestrator

            if orchestrator.background_workers <= 1:
                return 1
        except Exception:
            return 1
        return min(3, os.cpu_count() or 1)

    def _set_activity(self, value: str) -> None:
        with self._activity_lock:
            self._activity = value

    def _maybe_notify(self) -> None:
        if not self._measured_since_notify:
            return
        now = time.monotonic()
        if now - self._last_notify_at < NOTIFY_INTERVAL_SEC:
            return
        self._last_notify_at = now
        self._measured_since_notify = 0
        try:
            self._notify()
        except Exception:
            logger.debug("Loudness: could not announce new measurements", exc_info=True)

    # ----- defaults, resolved lazily to keep this importable on its own -----

    @staticmethod
    def _default_foreground_busy() -> bool:
        try:
            from shared.api import orchestrator, queue_manager_dl

            active = [
                task_id for task_id in orchestrator.active_jobs
                if not task_id.startswith("loudness_")
            ]
            queue_busy = any(
                item.get("status") in {"pending", "downloading"}
                for item in queue_manager_dl.list_items()
            )
            if active or queue_busy:
                return True
        except Exception:
            return True

        try:
            from shared.lossless.service import LosslessUpgradeService
            from shared.user_context import users_config_root

            return LosslessUpgradeService.playback_live(users_config_root())
        except Exception:
            return True

    @staticmethod
    def _default_inventory() -> Iterable[tuple[Any, str]]:
        from shared.api import get_user_core
        from shared.user_context import user_context
        from shared.users import list_users

        seen: set[str] = set()
        for account in list_users():
            with user_context(account["id"]):
                lib = get_user_core(account["id"]).library
                if not lib.metadata and lib.manifest_path.exists():
                    lib._load_from_cache(lib.manifest_path)
                for track in list(lib.metadata.tracks if lib.metadata else []):
                    if track.id in seen:
                        continue
                    path = resolve_local_track_path(track)
                    if path:
                        seen.add(track.id)
                        yield track, path

    @staticmethod
    def _favourite_ids() -> list[str]:
        from shared.api import favourite_library_ids
        from shared.user_context import user_context
        from shared.users import list_users

        ordered: list[str] = []
        for account in list_users():
            with user_context(account["id"]):
                ordered.extend(favourite_library_ids(account["id"]))
        return ordered

    @staticmethod
    def _default_notify() -> None:
        from shared.api import socketio

        socketio.emit("loudness_updated")


_SERVICE: LoudnessService | None = None
_SERVICE_LOCK = threading.Lock()


def get_loudness_service() -> LoudnessService:
    global _SERVICE
    with _SERVICE_LOCK:
        if _SERVICE is None:
            _SERVICE = LoudnessService()
        return _SERVICE


def stop_loudness_service_if_started() -> None:
    global _SERVICE
    with _SERVICE_LOCK:
        service, _SERVICE = _SERVICE, None
    if service is not None:
        service.stop()
