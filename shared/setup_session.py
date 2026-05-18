"""
In-process setup funnel state for Phase 1 setup-events (see docs/LAYER_CONTRACTS.md §3.1).

Correlates setup_session_started → setup_step_completed → setup_first_play. Sessions are
process-local; multi-process deployments would need a shared store for strict gate math.
"""

from __future__ import annotations

import threading
import time
import uuid
from typing import Any, Optional

_lock = threading.Lock()
_sessions: dict[str, dict[str, Any]] = {}

_SESSION_TTL_SEC = 86_400


def _prune_unlocked(now: int) -> None:
    if len(_sessions) <= 10_000:
        return
    cutoff = now - _SESSION_TTL_SEC
    stale = [sid for sid, st in _sessions.items() if st.get("started_ts", 0) < cutoff]
    for sid in stale[:5000]:
        _sessions.pop(sid, None)


def normalize_setup_session_id(raw: Optional[str]) -> Optional[str]:
    if raw is None:
        return None
    text = str(raw).strip()
    if not text:
        return None
    try:
        return str(uuid.UUID(text))
    except ValueError:
        return None


def ensure_session(setup_session_id: Optional[str] = None) -> tuple[str, int, bool]:
    """Return (session_id, started_ts_unix, is_new_session). Creates session if id missing or unknown."""
    sid_in = normalize_setup_session_id(setup_session_id)
    now = int(time.time())
    with _lock:
        _prune_unlocked(now)
        if sid_in and sid_in in _sessions:
            return sid_in, int(_sessions[sid_in]["started_ts"]), False
        sid = sid_in or str(uuid.uuid4())
        is_new = sid not in _sessions
        if sid not in _sessions:
            _sessions[sid] = {"started_ts": now, "first_play_done": False}
        return sid, int(_sessions[sid]["started_ts"]), is_new


def try_emit_setup_first_play(
    setup_session_id: Optional[str],
    *,
    track_id: Optional[str] = None,
) -> bool:
    """
    Emit setup_first_play at most once per session when playback confirms.
    Returns True if an event was emitted.
    """
    sid = normalize_setup_session_id(setup_session_id)
    if not sid:
        return False

    from shared.telemetry import emit

    with _lock:
        st = _sessions.get(sid)
        if st is None:
            # Allow first play if client reused a valid UUID we did not see yet (e.g. restart)
            now = int(time.time())
            _sessions[sid] = {"started_ts": now, "first_play_done": False}
            st = _sessions[sid]
        if st.get("first_play_done"):
            return False
        st["first_play_done"] = True
        started = int(st["started_ts"])
        now = int(time.time())

    elapsed_ms = max(0, (now - started) * 1000)
    payload: dict[str, Any] = {
        "v": 1,
        "event": "setup_first_play",
        "ts": now,
        "setup_session_id": sid,
        "elapsed_ms_since_session": elapsed_ms,
    }
    if isinstance(track_id, str) and track_id.strip():
        payload["track_id"] = track_id.strip()[:128]

    emit("setup", payload)
    return True


def reset_sessions_for_tests() -> None:
    """Clear registry (unit tests only)."""
    with _lock:
        _sessions.clear()
