import os
import threading
import logging
import time
from concurrent.futures import ThreadPoolExecutor, Future
from pathlib import Path
from typing import Callable, Any, Dict, Optional

logger = logging.getLogger(__name__)


# Disk profile constants
PROFILE_HDD = "hdd"
PROFILE_SSD = "ssd"
PROFILE_AUTO = "auto"

# Pool sizing by profile. Metadata lane is always serialized (1 worker)
# regardless of profile so commit ordering is preserved (see run_serialized
# + schedule_metadata_commit).
_PROFILE_BACKGROUND_WORKERS = {
    PROFILE_HDD: 1,   # HDD: cap disk-heavy concurrency at 1 (plan 6A)
    PROFILE_SSD: 3,
}


def detect_rotational_disk(path: Optional[Path] = None) -> bool:
    """
    Best-effort rotational-disk detection. Returns True if the disk hosting
    `path` is rotational (HDD), False otherwise (including unknown).

    Linux: reads /sys/block/<dev>/queue/rotational. Other platforms return
    False — caller should rely on explicit config flag instead.
    """
    if path is None:
        path = Path.cwd()
    try:
        if not hasattr(os, "stat") or not Path("/sys/block").is_dir():
            return False
        st = os.stat(str(path))
        # Map (major, minor) → block device name via /proc/partitions
        major = os.major(st.st_dev)
        minor = os.minor(st.st_dev)
        with open("/proc/partitions", "r") as f:
            for line in f.readlines()[2:]:
                parts = line.split()
                if len(parts) < 4:
                    continue
                if int(parts[0]) == major and int(parts[1]) == minor:
                    dev = parts[3]
                    # Strip partition suffix (sda1 → sda, nvme0n1p1 → nvme0n1)
                    base = dev.rstrip("0123456789")
                    if base.endswith("p") and "nvme" in base:
                        base = base[:-1]
                    rot_path = Path(f"/sys/block/{base}/queue/rotational")
                    if rot_path.exists():
                        return rot_path.read_text().strip() == "1"
        return False
    except Exception as e:
        logger.debug(f"Orchestrator: rotational detect failed: {e}")
        return False


class JobOrchestrator:
    """
    Manages background jobs with two executor pools and a serialized
    metadata lane.

    Pools (plan 6A):
    - background pool: disk-heavy work (downloads, transcodes, scans, sync).
      Sized by disk profile — HDD=1, SSD=3.
    - metadata pool:   serialized commits (max_workers=1). Combined with
      `commit_lock` to preserve ordering across pump callers.
    """

    _instance = None
    _lock = threading.Lock()

    @classmethod
    def get_instance(cls):
        with cls._lock:
            if cls._instance is None:
                cls._instance = cls()
            return cls._instance

    @classmethod
    def _reset_instance_for_tests(cls):
        """Drop the singleton — tests only."""
        with cls._lock:
            if cls._instance is not None:
                try:
                    cls._instance.shutdown(wait=False)
                except Exception:
                    pass
            cls._instance = None

    def __init__(self, profile: str = PROFILE_SSD, music_dir: Optional[Path] = None):
        self.state_lock = threading.Lock()
        self.commit_lock = threading.Lock()
        self.active_jobs: Dict[str, Future] = {}

        # Metadata coalescing
        self.pending_commits = False
        self.last_commit_time = 0.0
        self.commit_debounce_sec = 2.0
        self.commit_timer: Optional[threading.Timer] = None

        # Downloader pump supervisor — owned by orchestrator so shutdown
        # can join it and double-start is rejected (plan 5A).
        self._pump_thread: Optional[threading.Thread] = None
        self._pump_stop: Optional[threading.Event] = None

        self.profile = PROFILE_SSD
        self.background_executor: Optional[ThreadPoolExecutor] = None
        self.metadata_executor: Optional[ThreadPoolExecutor] = None
        self.configure_disk_profile(profile, music_dir=music_dir)

    # ----- Pool configuration -----

    def configure_disk_profile(self, profile: str, music_dir: Optional[Path] = None) -> str:
        """
        Apply a disk profile. Resolves "auto" via detect_rotational_disk.
        Rebuilds the background pool if the worker count changes; the
        metadata pool is always 1.
        Returns the resolved profile string.
        """
        if profile == PROFILE_AUTO:
            resolved = PROFILE_HDD if detect_rotational_disk(music_dir) else PROFILE_SSD
        elif profile in (PROFILE_HDD, PROFILE_SSD):
            resolved = profile
        else:
            logger.warning(f"Orchestrator: unknown profile '{profile}', defaulting to SSD")
            resolved = PROFILE_SSD

        target_bg = _PROFILE_BACKGROUND_WORKERS[resolved]

        with self.state_lock:
            current_bg = getattr(self.background_executor, "_max_workers", None)
            if self.background_executor is None or current_bg != target_bg:
                if self.background_executor is not None:
                    if self.active_jobs:
                        logger.warning(
                            "Orchestrator: reconfiguring pool with %d active jobs; "
                            "old executor will drain in background.",
                            len(self.active_jobs),
                        )
                    self.background_executor.shutdown(wait=False)
                self.background_executor = ThreadPoolExecutor(
                    max_workers=target_bg, thread_name_prefix="JobOrch-bg"
                )
            if self.metadata_executor is None:
                self.metadata_executor = ThreadPoolExecutor(
                    max_workers=1, thread_name_prefix="JobOrch-meta"
                )
            self.profile = resolved

        logger.info(
            f"Orchestrator: profile={resolved} background_workers={target_bg} metadata_workers=1"
        )
        return resolved

    @property
    def background_workers(self) -> int:
        return _PROFILE_BACKGROUND_WORKERS[self.profile]

    # ----- Submission API -----

    def submit_background(self, task_id: str, func: Callable, *args, **kwargs) -> Future:
        """Submit a disk-heavy background job (download / transcode / scan / sync)."""
        with self.state_lock:
            if task_id in self.active_jobs:
                return self.active_jobs[task_id]
            future = self.background_executor.submit(self._wrap_task, task_id, func, *args, **kwargs)
            self.active_jobs[task_id] = future
            return future

    # Backwards-compatible alias — existing call sites route to background pool.
    def submit_task(self, task_id: str, func: Callable, *args, **kwargs) -> Future:
        return self.submit_background(task_id, func, *args, **kwargs)

    def submit_metadata(self, task_id: str, func: Callable, *args, **kwargs) -> Future:
        """Submit a metadata job to the serialized metadata lane."""
        with self.state_lock:
            if task_id in self.active_jobs:
                return self.active_jobs[task_id]

            def _serialized():
                with self.commit_lock:
                    return func(*args, **kwargs)

            future = self.metadata_executor.submit(self._wrap_task, task_id, _serialized)
            self.active_jobs[task_id] = future
            return future

    def _wrap_task(self, task_id: str, func: Callable, *args, **kwargs):
        try:
            return func(*args, **kwargs)
        except Exception as e:
            logger.error(f"Orchestrator: Task {task_id} failed: {e}")
            raise
        finally:
            with self.state_lock:
                if task_id in self.active_jobs:
                    del self.active_jobs[task_id]

    def run_serialized(self, func: Callable, *args, **kwargs):
        """Run a task exclusively in the caller's thread (e.g. metadata write)."""
        with self.commit_lock:
            return func(*args, **kwargs)

    def schedule_metadata_commit(self, commit_func: Callable, emit_func: Optional[Callable] = None):
        """
        Schedule a metadata commit with debouncing/coalescing.
        Multiple calls in short succession will trigger only one commit.
        """
        with self.state_lock:
            self.pending_commits = True

            if self.commit_timer:
                self.commit_timer.cancel()

            def _do_commit():
                with self.commit_lock:
                    logger.info("Orchestrator: Executing coalesced metadata commit...")
                    try:
                        commit_func()
                        if emit_func:
                            emit_func()
                    except Exception as e:
                        logger.error(f"Orchestrator: Metadata commit failed: {e}")
                    finally:
                        with self.state_lock:
                            self.pending_commits = False
                            self.last_commit_time = time.time()
                            self.commit_timer = None

            self.commit_timer = threading.Timer(self.commit_debounce_sec, _do_commit)
            self.commit_timer.start()
            logger.debug("Orchestrator: Metadata commit scheduled (debounced).")

    # ----- Downloader pump supervision (plan 5A) -----

    def start_downloader_pump(self, pump_func: Callable[[threading.Event], None]) -> bool:
        """
        Idempotently start the downloader pump supervisor.

        The pump is a long-running loop that submits download work to the
        background executor and sleeps between checks. We do NOT submit the
        pump itself to a pool (would deadlock HDD=1). Instead the
        orchestrator owns one dedicated supervisor thread so shutdown can
        signal it and tests can verify single-instance semantics.

        Returns True if a pump was started, False if one was already running.
        `pump_func` must accept a `threading.Event` and return when it is set.
        """
        with self.state_lock:
            if self._pump_thread is not None and self._pump_thread.is_alive():
                return False
            self._pump_stop = threading.Event()
            stop_event = self._pump_stop
            t = threading.Thread(
                target=self._run_pump,
                args=(pump_func, stop_event),
                name="JobOrch-pump",
                daemon=True,
            )
            self._pump_thread = t
            t.start()
            return True

    def _run_pump(self, pump_func: Callable[[threading.Event], None], stop_event: threading.Event) -> None:
        try:
            pump_func(stop_event)
        except Exception as e:
            logger.error("Orchestrator: downloader pump crashed: %s", e)

    def stop_downloader_pump(self, wait: bool = True, timeout: float = 5.0) -> None:
        """Signal the pump to exit and optionally join it."""
        with self.state_lock:
            stop = self._pump_stop
            thread = self._pump_thread
        if stop is not None:
            stop.set()
        if wait and thread is not None and thread.is_alive():
            thread.join(timeout=timeout)

    def pump_is_running(self) -> bool:
        with self.state_lock:
            return self._pump_thread is not None and self._pump_thread.is_alive()

    def shutdown(self, wait: bool = True) -> None:
        self.stop_downloader_pump(wait=wait)
        if self.commit_timer:
            try:
                self.commit_timer.cancel()
            except Exception:
                pass
        if self.background_executor:
            self.background_executor.shutdown(wait=wait)
        if self.metadata_executor:
            self.metadata_executor.shutdown(wait=wait)


orchestrator = JobOrchestrator.get_instance()
