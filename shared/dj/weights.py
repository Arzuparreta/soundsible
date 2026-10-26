"""Beat This! ONNX weights: locate, verify, download once and open one session.

The file is a Soundsible release asset with a fixed SHA-256 (MIT, from
Beat This! `final0`; export in docs/dj/detector_comparison/onnx_probe.py).
Docker images and desktop builds carry it under `models/`; a source install
downloads it into the cache the first time it analyses. Without verified
weights there is no pulse detector: analysis waits rather than guessing.
"""

from __future__ import annotations

import hashlib
import logging
import os
import sys
import threading
import time
from pathlib import Path

from shared.runtime import get_cache_dir

logger = logging.getLogger(__name__)

MODEL_FILE = "beat_this-final0.onnx"
MODEL_SHA256 = "c31e46719845b8111259289885996629735ba0d2815bfcef2da4f7dc6224aa31"
MODEL_BYTES = 84_249_656
MODEL_TAG = "dj-model-beat-this-final0-1"
MODEL_RELEASES = "https://github.com/Arzuparreta/soundsible/releases/download"
MODEL_URL = f"{MODEL_RELEASES}/{MODEL_TAG}/{MODEL_FILE}"
ENVIRONMENT = "SOUNDSIBLE_BEAT_MODEL"
# A failed download is retried on a later analysis, not on every candidate.
_RETRY_SECONDS = 600.0

_lock = threading.Lock()
_session = None
_failed_at = 0.0
_verified: set[Path] = set()


def bundled_path() -> Path:
    """`models/` beside `shared/`: the repository, Docker's /app or PyInstaller's bundle."""
    root = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parents[2]))
    return root / "models" / MODEL_FILE


def cached_path() -> Path:
    return get_cache_dir() / "models" / MODEL_FILE


def _verified_file(path: Path) -> bool:
    if path in _verified:
        return True
    try:
        if path.stat().st_size != MODEL_BYTES:
            return False
        digest = hashlib.sha256()
        with path.open("rb") as stream:
            for block in iter(lambda: stream.read(1 << 20), b""):
                digest.update(block)
    except OSError:
        return False
    if digest.hexdigest() != MODEL_SHA256:
        return False
    _verified.add(path)
    return True


def _inline(function, *args):
    return function(*args)


def _download(target: Path, run) -> bool:
    import requests

    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_suffix(".part")
    try:
        with requests.get(MODEL_URL, stream=True, timeout=(10, 60)) as response:
            response.raise_for_status()
            with partial.open("wb") as stream:
                for block in response.iter_content(1 << 20):
                    stream.write(block)
        if not run(_verified_file, partial):
            logger.warning("DJ beat model download did not match its SHA-256; discarded")
            partial.unlink(missing_ok=True)
            return False
        partial.replace(target)
        _verified.discard(partial)
        _verified.add(target)
        return True
    except (OSError, requests.RequestException) as exc:
        logger.warning("DJ beat model download failed: %s", exc)
        partial.unlink(missing_ok=True)
        return False


def model_path(*, download: bool = True, run=_inline) -> Path | None:
    """A verified weights file, downloading it into the cache if allowed.

    `run(function, *args)` executes the CPU-bound hashing; the download itself
    stays in the caller, whose sockets may be cooperative.
    """
    explicit = os.environ.get(ENVIRONMENT, "").strip()
    candidates = [Path(explicit)] if explicit else [bundled_path(), cached_path()]
    for path in candidates:
        if run(_verified_file, path):
            return path
    if explicit or not download:
        return None
    target = cached_path()
    return target if _download(target, run) else None


def _runtime():
    """ONNX Runtime with its telemetry off.

    Its Linux build carries Microsoft's 1DS telemetry, which keeps a device id
    and an event store under ~/.cache/Microsoft and uploads to
    mobile.events.data.microsoft.com. A self-hosted analyser sends nothing:
    the variable must be set before the import; the call covers the rest.
    """
    os.environ["ORT_DISABLE_TELEMETRY"] = "1"
    import onnxruntime as ort

    ort.disable_telemetry_events()
    return ort


def _open(path: Path):
    ort = _runtime()
    options = ort.SessionOptions()
    options.intra_op_num_threads = 1
    options.inter_op_num_threads = 1
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    return ort.InferenceSession(str(path), options, providers=["CPUExecutionProvider"])


def session(run=_inline):
    """One ONNX Runtime session with one thread, or None while unavailable.

    Called from an analysis job, never from a request: the first call may
    download 84 MB. `run` executes hashing and model loading off a cooperative
    loop. Callers serialise inference themselves (see `store`).
    """
    global _session, _failed_at
    with _lock:
        if _session is not None:
            return _session
        if _failed_at and time.monotonic() - _failed_at < _RETRY_SECONDS:
            return None
        try:
            run(_runtime)
        except ImportError:
            logger.warning("onnxruntime is not installed; DJ pulse analysis is unavailable")
            _failed_at = time.monotonic()
            return None
        path = model_path(run=run)
        if path is None:
            _failed_at = time.monotonic()
            return None
        _session = run(_open, path)
        return _session
