from __future__ import annotations

import hashlib
import json
import logging
import os
import shutil
import subprocess
import tempfile
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Iterable
from urllib.parse import urljoin

import acoustid
import requests
from dotenv import dotenv_values

from shared.models import Track
from shared.path_resolver import resolve_local_track_path

from .matching import metadata_match
from .models import LosslessCandidate, LosslessProvider
from .providers import USER_AGENT, allowed_download_url, default_providers
from .store import LosslessStore

logger = logging.getLogger(__name__)

MAX_TRACKS_PER_DAY = 25
MAX_BYTES_PER_DAY = 1024 * 1024 * 1024
MAX_CANDIDATE_BYTES = 250 * 1024 * 1024
MAX_CANDIDATE_DOWNLOADS = 2
QUIET_SECONDS = 60
NO_MATCH_TTL = 30 * 24 * 60 * 60
TRANSIENT_RETRY_MAX = 24 * 60 * 60
INVENTORY_INTERVAL = 60 * 60
LOSSLESS_FORMATS = {"flac", "wav", "wave", "alac", "aiff", "aif"}
# A player that is really playing republishes its state every 15s. Anything
# older is a client that went away without saying goodbye (killed tab, phone
# asleep, network drop) and must not keep the idle worker blocked forever.
PLAYBACK_STATE_FRESH_SEC = 180


class Preempted(RuntimeError):
    pass


def lossless_enabled() -> bool:
    raw = os.getenv("SOUNDSIBLE_LOSSLESS_UPGRADES")
    if raw is None:
        env_path = Path(__file__).resolve().parents[2] / "odst_tool" / ".env"
        raw = str((dotenv_values(env_path) if env_path.exists() else {}).get(
            "SOUNDSIBLE_LOSSLESS_UPGRADES", "true"
        ))
    return raw.strip().casefold() not in {
        "0",
        "false",
        "no",
        "off",
    }


def _safe_error(exc: BaseException) -> str:
    return " ".join(str(exc).replace("\x00", " ").split())[:500]


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


class LosslessUpgradeService:
    def __init__(
        self,
        *,
        store: LosslessStore | None = None,
        providers: Iterable[LosslessProvider] | None = None,
        foreground_busy: Callable[[], bool] | None = None,
        inventory: Callable[[], Iterable[tuple[Track, str]]] | None = None,
        replace_track: Callable[[Track, Path, LosslessCandidate, dict[str, Any]], bool] | None = None,
        quiet_seconds: int = QUIET_SECONDS,
    ):
        self.store = store or LosslessStore()
        self.providers = list(providers) if providers is not None else list(default_providers())
        self._foreground_busy = foreground_busy or self._default_foreground_busy
        self._inventory = inventory or self._default_inventory
        self._replace_track = replace_track or self._default_replace_track
        self.quiet_seconds = max(0, int(quiet_seconds))
        self._stop = threading.Event()
        self._wake = threading.Event()
        self._thread: threading.Thread | None = None
        self._quiet_since: float | None = None
        self._last_inventory_at: float | None = None
        self._activity_lock = threading.Lock()
        self._activity = "stopped"
        self._current_track_id: str | None = None
        # Manual run: the user asking for upgrades *now*, which suspends the
        # idle/quiet gate and the daily examination cap until the ready queue
        # drains or they pause or cancel it.
        self._manual_mode = "off"  # off | running | paused
        self._manual_abort = threading.Event()
        self._manual_processed = 0
        self._manual_started_at: float | None = None
        self._manual_inventoried = False

    def start(self) -> bool:
        if self._thread and self._thread.is_alive():
            return False
        self._stop.clear()
        self._wake.clear()
        self.store.recover_interrupted()
        self._thread = threading.Thread(
            target=self._run,
            name="lossless-idle",
            daemon=True,
        )
        self._thread.start()
        return True

    def stop(self, timeout: float = 3.0) -> None:
        self._stop.set()
        self._wake.set()
        thread = self._thread
        if thread and thread.is_alive():
            thread.join(timeout=timeout)
        with self._activity_lock:
            self._activity = "stopped"

    def wake(self) -> None:
        self._wake.set()

    def reload_providers(self) -> None:
        """Adopt provider credentials changed through the admin settings UI."""
        self.providers = list(default_providers())
        self.wake()

    # ── Manual run ────────────────────────────────────────────────────────

    def manual_state(self) -> str:
        with self._activity_lock:
            return self._manual_mode

    def start_manual(self, *, recheck: bool = False) -> int:
        """Run the queue now, ignoring the idle gate and the daily cap.

        ``recheck`` also puts every previously unmatched track back in line and
        drops the cached provider answers, so a manual run actually asks the
        providers again instead of replaying a month-old "no match".
        """
        requeued = self.store.requeue_all() if recheck else 0
        with self._activity_lock:
            self._manual_mode = "running"
            self._manual_processed = 0
            self._manual_started_at = time.time()
        self._manual_abort.clear()
        self._manual_inventoried = False
        self.start()
        self.wake()
        return requeued

    def pause_manual(self) -> bool:
        with self._activity_lock:
            if self._manual_mode != "running":
                return False
            self._manual_mode = "paused"
            self._activity = "paused"
        self._manual_abort.set()
        self.wake()
        return True

    def resume_manual(self) -> bool:
        with self._activity_lock:
            if self._manual_mode != "paused":
                return False
            self._manual_mode = "running"
        self._manual_abort.clear()
        self.wake()
        return True

    def cancel_manual(self) -> bool:
        with self._activity_lock:
            if self._manual_mode == "off":
                return False
            self._manual_mode = "off"
            self._activity = "waiting"
        self._manual_abort.set()
        self.wake()
        return True

    def _end_manual(self, activity: str) -> None:
        with self._activity_lock:
            self._manual_mode = "off"
            self._activity = activity
            self._current_track_id = None
        self._manual_abort.clear()

    def status(self) -> dict[str, Any]:
        summary = self.store.summary()
        with self._activity_lock:
            activity = self._activity
            current = self._current_track_id
            manual_mode = self._manual_mode
            processed = self._manual_processed
            started_at = self._manual_started_at
        thread = self._thread
        budget = self.store.budget(self._day())
        return {
            "enabled": lossless_enabled(),
            "activity": activity,
            "current_track_id": current,
            "running": bool(thread and thread.is_alive()),
            "manual": {
                "state": manual_mode,
                "processed": processed,
                "started_at": started_at,
            },
            "queued": self.store.ready_count(),
            "budget": {
                **budget,
                "max_tracks": MAX_TRACKS_PER_DAY,
                "max_bytes": MAX_BYTES_PER_DAY,
            },
            "providers": [
                {"name": provider.name, "available": bool(provider.available)}
                for provider in self.providers
            ],
            "identity_verifier_available": shutil.which("fpcalc") is not None,
            **summary,
        }

    def run_once(self) -> bool:
        """One scheduler iteration in whichever mode is active."""
        if self.manual_state() == "off":
            return self.run_once_if_idle()
        return self.run_once_manual()

    def run_once_manual(self) -> bool:
        """One iteration of an explicitly requested run; public for tests."""
        if self.manual_state() == "paused":
            self._set_activity("paused")
            return False
        self._manual_abort.clear()
        if shutil.which("fpcalc") is None:
            self._end_manual("unavailable")
            return False
        if not self._manual_inventoried:
            self._set_activity("inventory")
            self._refresh_inventory()
            self._last_inventory_at = time.monotonic()
            self._manual_inventoried = True
        job = self.store.next_ready()
        if not job:
            self._end_manual("idle")
            return False
        self._process_job(job)
        with self._activity_lock:
            self._manual_processed += 1
        return self.manual_state() == "running"

    def run_once_if_idle(self) -> bool:
        """One scheduler iteration; public for deterministic tests."""
        if not lossless_enabled():
            self._set_activity("disabled")
            return False
        if self._foreground_busy():
            self._quiet_since = None
            self._set_activity("waiting")
            return False
        now = time.monotonic()
        if self._quiet_since is None:
            self._quiet_since = now
            self._set_activity("waiting")
            return False
        if now - self._quiet_since < self.quiet_seconds:
            self._set_activity("waiting")
            return False
        if not self._budget_available():
            self._set_activity("budget_exhausted")
            return False
        if shutil.which("fpcalc") is None:
            self._set_activity("unavailable")
            return False

        if (
            self._last_inventory_at is None
            or now - self._last_inventory_at >= INVENTORY_INTERVAL
        ):
            self._set_activity("inventory")
            self._refresh_inventory()
            self._last_inventory_at = now
        job = self.store.next_ready()
        if not job:
            self._set_activity("idle")
            return False
        self._process_job(job)
        return True

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                worked = self.run_once()
            except Exception:
                logger.exception("Lossless idle scheduler iteration failed")
                worked = False
            self._wake.wait(timeout=2 if worked else 10)
            self._wake.clear()

    def _set_activity(self, value: str, track_id: str | None = None) -> None:
        with self._activity_lock:
            self._activity = value
            self._current_track_id = track_id

    def _yield_reason(self) -> str | None:
        """Why the worker must drop what it is doing, or ``None`` to carry on."""
        if self._stop.is_set():
            return "shutdown requested"
        if self._manual_abort.is_set():
            return "manual run interrupted"
        if self.manual_state() == "running":
            return None
        return "foreground work started" if self._foreground_busy() else None

    def _should_yield(self) -> bool:
        return self._yield_reason() is not None

    def _preempt_if_busy(self) -> None:
        reason = self._yield_reason()
        if reason:
            raise Preempted(reason)

    def _day(self) -> str:
        return datetime.now().astimezone().date().isoformat()

    def _budget_available(self) -> bool:
        budget = self.store.budget(self._day())
        return (
            budget["tracks_examined"] < MAX_TRACKS_PER_DAY
            and budget["bytes_downloaded"] < MAX_BYTES_PER_DAY
        )

    def _refresh_inventory(self) -> None:
        for track, path in self._inventory():
            if self._should_yield():
                return
            fmt = str(getattr(track, "format", "") or "").casefold().lstrip(".")
            media_kind = str(getattr(track, "media_kind", "") or "music")
            duration = int(getattr(track, "duration", 0) or 0)
            if (
                not getattr(track, "youtube_id", None)
                or fmt in LOSSLESS_FORMATS
                or getattr(track, "audio_quality", None) == "lossless"
                or media_kind not in {"", "music"}
                or duration < 30
                or duration > 1800
                or not Path(path).is_file()
            ):
                continue
            self.store.enqueue(track.id, track.youtube_id)

    def _process_job(self, job: dict[str, Any]) -> None:
        track_id = str(job["track_id"])
        self._set_activity("processing", track_id)
        if job.get("status") == "committing":
            self._resume_commit(job)
            return
        found = self._find_track(track_id)
        if not found:
            self.store.update(track_id, "completed", last_error="track no longer exists")
            return
        track, current_path = found
        attempts = int(job.get("attempts") or 0) + 1
        self.store.update(track_id, "searching", attempts=attempts, last_error=None)
        self.store.add_budget(self._day(), tracks=1)

        downloads = 0
        try:
            diagnostics: list[str] = []
            available_providers = 0
            failed_providers = 0
            for provider in self.providers:
                self._preempt_if_busy()
                if not provider.available:
                    continue
                available_providers += 1
                try:
                    candidates = self._provider_candidates(provider, track)
                except Exception as exc:
                    failed_providers += 1
                    diagnostics.append(f"{provider.name}: {_safe_error(exc)}")
                    logger.info("Lossless provider %s failed for %s: %s", provider.name, track_id, exc)
                    continue
                for candidate in candidates:
                    if downloads >= MAX_CANDIDATE_DOWNLOADS:
                        break
                    if not metadata_match(track, candidate):
                        continue
                    downloads += 1
                    self.store.update(
                        track_id,
                        "downloading",
                        provider=provider.name,
                        candidate_json=candidate.to_dict(),
                    )
                    try:
                        temp_path = self._download_candidate(candidate)
                    except Preempted:
                        raise
                    except Exception as exc:
                        diagnostics.append(
                            f"{provider.name}/{candidate.source_id}: {_safe_error(exc)}"
                        )
                        continue
                    try:
                        self.store.update(track_id, "verifying")
                        self._validate_lossless(temp_path, candidate)
                        matched, score = self._fingerprint_match_cancelable(
                            Path(current_path), temp_path
                        )
                        if not matched:
                            logger.info(
                                "Lossless candidate rejected for %s: fingerprint %.4f",
                                track_id,
                                score,
                            )
                            continue
                        replacement = {
                            "fingerprint_similarity": score,
                            "provider_original": candidate.original,
                        }
                        if self._replace_track(track, temp_path, candidate, replacement):
                            self.store.update(track_id, "completed", last_error=None)
                            self._set_activity("idle")
                            return
                        # A false result means the crash-safe commit journal is
                        # still converging. Do not overwrite it with no_match.
                        return
                    except Preempted:
                        raise
                    except Exception as exc:
                        diagnostics.append(
                            f"{provider.name}/{candidate.source_id}: {_safe_error(exc)}"
                        )
                        logger.info(
                            "Lossless candidate %s failed verification for %s: %s",
                            candidate.source_id,
                            track_id,
                            exc,
                        )
                        continue
                    finally:
                        if temp_path.exists():
                            temp_path.unlink(missing_ok=True)
                if downloads >= MAX_CANDIDATE_DOWNLOADS:
                    break
            if available_providers and failed_providers == available_providers:
                raise RuntimeError("; ".join(diagnostics))
            self.store.update(
                track_id,
                "no_match",
                next_attempt_at=int(time.time()) + NO_MATCH_TTL,
                last_error="; ".join(diagnostics)[:500] or None,
            )
        except Preempted as exc:
            # A paused or cancelled manual run keeps the job at the head of the
            # queue: the user interrupted it, so resuming should carry on here
            # rather than serve a 60s penalty meant for foreground contention.
            self.store.update(
                track_id,
                "retry",
                next_attempt_at=int(time.time()) + (0 if self.manual_state() != "off" else 60),
                last_error=_safe_error(exc),
            )
            self._quiet_since = None
        except Exception as exc:
            delay = min(TRANSIENT_RETRY_MAX, 60 * (2 ** min(attempts, 8)))
            logger.info("Lossless upgrade attempt failed for %s: %s", track_id, exc)
            self.store.update(
                track_id,
                "retry",
                next_attempt_at=int(time.time()) + delay,
                last_error=_safe_error(exc),
            )
        finally:
            mode = self.manual_state()
            self._set_activity(
                "paused" if mode == "paused" else "processing" if mode == "running" else "waiting"
            )

    def _provider_candidates(
        self, provider: LosslessProvider, track: Track
    ) -> list[LosslessCandidate]:
        cached = self.store.cache_get(track.id, provider.name)
        if cached is not None:
            return [LosslessCandidate.from_dict(row) for row in cached]
        candidates = provider.search(track, limit=3)
        self.store.cache_put(
            track.id,
            provider.name,
            [candidate.to_dict() for candidate in candidates],
            NO_MATCH_TTL,
        )
        return candidates

    def _download_candidate(self, candidate: LosslessCandidate) -> Path:
        if candidate.expected_size and candidate.expected_size > MAX_CANDIDATE_BYTES:
            raise ValueError("lossless candidate exceeds size limit")
        if not allowed_download_url(candidate.provider, candidate.download_url):
            raise ValueError("untrusted lossless download URL")
        suffix = f".{candidate.format.casefold().lstrip('.')}"
        fd, raw_path = tempfile.mkstemp(prefix="soundsible-lossless-", suffix=suffix)
        os.close(fd)
        path = Path(raw_path)
        total = 0
        counted = False
        try:
            with self._open_download_response(candidate) as response:
                response.raise_for_status()
                declared = response.headers.get("Content-Length")
                if declared and int(declared) > MAX_CANDIDATE_BYTES:
                    raise ValueError("lossless candidate exceeds size limit")
                with path.open("wb") as handle:
                    for chunk in response.iter_content(chunk_size=256 * 1024):
                        self._preempt_if_busy()
                        if not chunk:
                            continue
                        total += len(chunk)
                        if total > MAX_CANDIDATE_BYTES:
                            raise ValueError("lossless candidate exceeds size limit")
                        budget = self.store.budget(self._day())
                        if budget["bytes_downloaded"] + total > MAX_BYTES_PER_DAY:
                            raise Preempted("daily lossless byte budget reached")
                        handle.write(chunk)
            if total == 0:
                raise ValueError("empty lossless candidate")
            self.store.add_budget(self._day(), bytes_downloaded=total)
            counted = True
            return path
        except Exception:
            path.unlink(missing_ok=True)
            raise
        finally:
            if total and not counted:
                self.store.add_budget(self._day(), bytes_downloaded=total)

    @staticmethod
    def _open_download_response(candidate: LosslessCandidate) -> requests.Response:
        """Follow only redirects that remain inside the provider allowlist."""
        url = candidate.download_url
        for _ in range(4):
            response = requests.get(
                url,
                stream=True,
                timeout=(3, 15),
                allow_redirects=False,
                headers={
                    "User-Agent": USER_AGENT,
                    "Accept": "audio/flac,audio/wav,application/octet-stream",
                },
            )
            if not getattr(response, "is_redirect", False):
                if not allowed_download_url(candidate.provider, response.url):
                    response.close()
                    raise ValueError("lossless response came from an untrusted host")
                return response
            redirected = urljoin(url, str(response.headers.get("Location") or ""))
            response.close()
            if not allowed_download_url(candidate.provider, redirected):
                raise ValueError("lossless download redirected to an untrusted host")
            url = redirected
        raise ValueError("too many lossless download redirects")

    def _validate_lossless(self, path: Path, candidate: LosslessCandidate) -> None:
        self._preempt_if_busy()
        result = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-select_streams",
                "a:0",
                "-show_entries",
                "stream=codec_name",
                "-of",
                "json",
                str(path),
            ],
            capture_output=True,
            text=True,
            timeout=20,
            check=True,
        )
        streams = json.loads(result.stdout or "{}").get("streams") or []
        codec = str((streams[0] if streams else {}).get("codec_name") or "").casefold()
        if codec not in {"flac", "alac", "pcm_s16le", "pcm_s24le", "pcm_s32le", "pcm_f32le"}:
            raise ValueError(f"provider returned non-lossless codec: {codec or 'unknown'}")

    def _fingerprint_match_cancelable(self, current: Path, candidate: Path) -> tuple[bool, float]:
        first = self._fingerprint_cancelable(current)
        second = self._fingerprint_cancelable(candidate)
        score = float(acoustid.compare_fingerprints(first, second))
        return score >= 0.90, score

    def _fingerprint_cancelable(self, path: Path) -> tuple[float, bytes]:
        proc = subprocess.Popen(
            ["fpcalc", "-length", "120", str(path)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        try:
            while proc.poll() is None:
                self._preempt_if_busy()
                if self._stop.wait(0.25):
                    raise Preempted("shutdown requested")
            stdout, stderr = proc.communicate()
            if proc.returncode != 0:
                raise ValueError(_safe_error(RuntimeError(stderr.decode(errors="replace"))))
            duration: float | None = None
            fingerprint: bytes | None = None
            for line in stdout.splitlines():
                key, _, value = line.partition(b"=")
                if key == b"DURATION":
                    duration = float(value)
                elif key == b"FINGERPRINT":
                    fingerprint = value
            if duration is None or fingerprint is None:
                raise ValueError("fpcalc returned incomplete fingerprint")
            return duration, fingerprint
        except Exception:
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    proc.kill()
            raise

    def _resume_commit(self, job: dict[str, Any]) -> None:
        snapshot = job.get("new_snapshot_json")
        new_path = Path(str(job.get("new_path") or ""))
        if not isinstance(snapshot, dict) or not new_path.is_file():
            self.store.update(
                str(job["track_id"]),
                "retry",
                next_attempt_at=int(time.time()) + 60,
                last_error="incomplete replacement journal",
            )
            return
        try:
            track = Track.from_dict(snapshot)
            candidate = LosslessCandidate.from_dict(job.get("candidate_json") or {})
            old = Track.from_dict(job.get("old_snapshot_json") or snapshot)
        except (KeyError, TypeError, ValueError) as exc:
            self.store.update(
                str(job["track_id"]),
                "retry",
                next_attempt_at=int(time.time()) + 60,
                last_error=f"invalid replacement journal: {_safe_error(exc)}",
            )
            return
        if self._commit_snapshot(old, track, new_path, candidate):
            self.store.update(str(job["track_id"]), "completed", last_error=None)

    def _default_replace_track(
        self,
        track: Track,
        candidate_path: Path,
        candidate: LosslessCandidate,
        evidence: dict[str, Any],
    ) -> bool:
        from odst_tool.audio_utils import AudioProcessor
        from shared.app_config import get_output_dir

        file_hash = _sha256(candidate_path)
        extension = candidate.format.casefold().lstrip(".")
        current_path = resolve_local_track_path(track)
        output_dir = get_output_dir()
        tracks_dir = (
            Path(output_dir).expanduser().resolve() / "tracks"
            if output_dir
            else Path(str(current_path)).resolve().parent
        )
        tracks_dir.mkdir(parents=True, exist_ok=True)
        final_path = tracks_dir / f"{file_hash}.{extension}"
        duration, bitrate, size = AudioProcessor.get_audio_details(str(candidate_path))
        snapshot = track.to_dict()
        snapshot.update(
            {
                "file_hash": file_hash,
                "original_filename": f"{track.artist} - {track.title}.{extension}",
                "compressed": False,
                "file_size": size,
                "bitrate": bitrate,
                "format": extension,
                "duration": duration or track.duration,
                "audio_quality": "lossless",
                "audio_source": candidate.provider,
                "audio_source_url": candidate.webpage_url,
                "audio_license_url": candidate.license_url,
                "audio_identity_verified": True,
            }
        )
        new_track = Track.from_dict(snapshot)
        old_path = current_path
        created = False
        try:
            if not final_path.exists():
                shutil.move(str(candidate_path), str(final_path))
                created = True
            self.store.update(
                track.id,
                "committing",
                provider=candidate.provider,
                candidate_json=candidate.to_dict(),
                old_snapshot_json=track.to_dict(),
                new_snapshot_json=new_track.to_dict(),
                old_path=old_path,
                new_path=str(final_path),
                last_error=None,
            )
        except Exception:
            if created:
                final_path.unlink(missing_ok=True)
            raise
        return self._commit_snapshot(track, new_track, final_path, candidate)

    def _commit_snapshot(
        self,
        old_track: Track,
        new_track: Track,
        new_path: Path,
        candidate: LosslessCandidate,
    ) -> bool:
        failures: list[str] = []
        try:
            from shared.api import get_downloader, get_user_core
            from shared.user_context import user_context
            from shared.users import list_users

            dl = get_downloader(open_browser=False)
            pool_track = dl.library.get_track_by_id(old_track.id) if dl and dl.library else None
            if pool_track:
                self._apply_technical_fields(pool_track, new_track)
                dl.save_library()

            for account in list_users():
                user_id = account["id"]
                try:
                    with user_context(user_id):
                        lib = get_user_core(user_id).library
                        if not lib.metadata:
                            lib.sync_library(silent=True)
                        target = lib.metadata.get_track_by_id(old_track.id) if lib.metadata else None
                        if not target:
                            continue
                        self._apply_technical_fields(target, new_track)
                        lib.metadata.version += 1
                        lib._save_metadata()
                except Exception as exc:
                    failures.append(f"{user_id}: {_safe_error(exc)}")
            if failures:
                self.store.update(
                    old_track.id,
                    "committing",
                    next_attempt_at=int(time.time()) + 60,
                    last_error="; ".join(failures)[:500],
                )
                return False

            old_path_text = str((self.store.get(old_track.id) or {}).get("old_path") or "")
            old_path = Path(old_path_text) if old_path_text else None
            if old_path is not None and old_path != new_path:
                try:
                    old_path.unlink(missing_ok=True)
                except OSError as exc:
                    logger.info("Could not remove superseded audio %s: %s", old_path, exc)

            # The upgraded file is different audio at a different level, and it
            # carries a new content hash — so it simply has no measurement yet
            # rather than inheriting the old one. Measuring it here means the
            # track is levelled the next time it plays instead of after the
            # next sweep.
            try:
                from shared.loudness import get_loudness_service

                get_loudness_service().measure_now(old_track.id)
            except Exception:
                logger.debug("Could not measure upgraded audio for %s", old_track.id, exc_info=True)
            return True
        except Exception as exc:
            self.store.update(
                old_track.id,
                "committing",
                next_attempt_at=int(time.time()) + 60,
                last_error=_safe_error(exc),
            )
            return False

    @staticmethod
    def _apply_technical_fields(target: Track, source: Track) -> None:
        for field in (
            "file_hash",
            "original_filename",
            "compressed",
            "file_size",
            "bitrate",
            "format",
            "duration",
            "audio_quality",
            "audio_source",
            "audio_source_url",
            "audio_license_url",
            "audio_identity_verified",
        ):
            setattr(target, field, getattr(source, field, None))

    @staticmethod
    def _default_inventory() -> Iterable[tuple[Track, str]]:
        from shared.api import get_user_core
        from shared.user_context import user_context
        from shared.users import list_users

        seen: set[str] = set()
        for account in list_users():
            with user_context(account["id"]):
                lib = get_user_core(account["id"]).library
                if not lib.metadata:
                    lib.sync_library(silent=True)
                for track in list(lib.metadata.tracks if lib.metadata else []):
                    if track.id in seen:
                        continue
                    path = resolve_local_track_path(track)
                    if path:
                        seen.add(track.id)
                        yield track, path

    def _find_track(self, track_id: str) -> tuple[Track, str] | None:
        for track, path in self._inventory():
            if track.id == track_id:
                return track, path
        return None

    @staticmethod
    def _default_foreground_busy() -> bool:
        try:
            from shared.api import orchestrator, queue_manager_dl

            active = [
                task_id
                for task_id in orchestrator.active_jobs
                if not task_id.startswith("lossless_")
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
            from shared.user_context import users_config_root

            return LosslessUpgradeService.playback_live(users_config_root())
        except Exception:
            return True

    @staticmethod
    def playback_live(users_root: Path, now: float | None = None) -> bool:
        """True while some device is actually playing something right now.

        Only a *live* player counts. A client that died mid-song (killed tab,
        phone asleep, network drop) leaves ``is_playing`` behind for good, and
        without the freshness window that one stale file would suspend upgrades
        for the whole instance, forever, for every user.
        """
        current = time.time() if now is None else now
        for path in users_root.glob("*/playback_state*.json"):
            try:
                state = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            if not isinstance(state, dict) or not state.get("is_playing"):
                continue
            try:
                updated = float(state.get("updated_at") or 0)
            except (TypeError, ValueError):
                continue
            if current - updated <= PLAYBACK_STATE_FRESH_SEC:
                return True
        return False


_SERVICE: LosslessUpgradeService | None = None
_SERVICE_LOCK = threading.Lock()


def get_lossless_service() -> LosslessUpgradeService:
    global _SERVICE
    with _SERVICE_LOCK:
        if _SERVICE is None:
            _SERVICE = LosslessUpgradeService()
        return _SERVICE


def stop_lossless_service_if_started() -> None:
    """Stop the worker without constructing it during an early shutdown."""
    with _SERVICE_LOCK:
        service = _SERVICE
    if service is not None:
        service.stop()
