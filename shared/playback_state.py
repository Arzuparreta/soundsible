"""
Playback state for cross-device resume (scoped for future multi-user).
Persists last playback state and tracks active devices per scope.
"""
import json
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Optional

from shared.constants import DEFAULT_CONFIG_DIR

DEFAULT_SCOPE = "default"
ACTIVE_DEVICE_TTL_SEC = 90
ACTIVE_DEVICE_CONSIDERED_RECENT_SEC = 60
STATE_TTL_SEC = 24 * 3600  # Note: 24H optional; state older can be ignored on GET

_lock = threading.Lock()
_active_devices: dict[str, dict[str, dict[str, Any]]] = {}  # Note: Scope -> device_id -> state
_registered_devices: dict[str, dict[str, dict[str, Any]]] = {}  # Note: Scope -> device_id -> metadata


def _config_dir() -> Path:
    return Path(DEFAULT_CONFIG_DIR).expanduser()


def _state_path(scope: str) -> Path:
    return _config_dir() / f"playback_state_{scope}.json"


def _cleanup_scope(scope: str) -> None:
    """Remove active devices/registrations with last_seen older than ACTIVE_DEVICE_TTL_SEC."""
    now = time.time()
    to_drop = [
        device_id
        for device_id, data in _active_devices.get(scope, {}).items()
        if (now - data.get("last_seen_ts", 0)) > ACTIVE_DEVICE_TTL_SEC
    ]
    for device_id in to_drop:
        _active_devices[scope].pop(device_id, None)
    registered_to_drop = [
        device_id
        for device_id, data in _registered_devices.get(scope, {}).items()
        if (now - data.get("last_seen_ts", 0)) > ACTIVE_DEVICE_TTL_SEC
    ]
    for device_id in registered_to_drop:
        _registered_devices[scope].pop(device_id, None)


def _ensure_scope(scope: str) -> None:
    if scope not in _active_devices:
        _active_devices[scope] = {}
    if scope not in _registered_devices:
        _registered_devices[scope] = {}


def get_scope_from_request() -> str:
    """Resolve scope from request context. v1: always default; v2: from auth/session."""
    return DEFAULT_SCOPE


def register_device(
    scope: str,
    *,
    device_id: Optional[str] = None,
    device_name: Optional[str] = None,
    device_type: Optional[str] = None,
) -> dict[str, Any]:
    """Register or refresh a device in a scope."""
    now = time.time()
    normalized_device_id = str(device_id or "").strip() or str(uuid.uuid4())
    normalized_type = (device_type or "desktop").strip().lower()
    if normalized_type not in {"mobile", "agent", "desktop"}:
        normalized_type = "desktop"
    device = {
        "device_id": normalized_device_id,
        "device_name": (device_name or normalized_device_id).strip(),
        "device_type": normalized_type,
        "scope": scope,
        "last_seen_ts": now,
        "registered_at": now,
    }
    with _lock:
        _ensure_scope(scope)
        _cleanup_scope(scope)
        existing = _registered_devices[scope].get(normalized_device_id) or {}
        if existing.get("registered_at"):
            device["registered_at"] = existing["registered_at"]
        _registered_devices[scope][normalized_device_id] = device
        active = _active_devices[scope].get(normalized_device_id)
        if active:
            active["device_name"] = device["device_name"]
            active["device_type"] = device["device_type"]
            active["last_seen_ts"] = now
    return device.copy()


def get_registered_device(scope: str, device_id: str) -> Optional[dict[str, Any]]:
    with _lock:
        _ensure_scope(scope)
        _cleanup_scope(scope)
        device = _registered_devices.get(scope, {}).get(device_id)
        return device.copy() if device else None


def list_registered_devices(scope: str) -> list[dict[str, Any]]:
    with _lock:
        _ensure_scope(scope)
        _cleanup_scope(scope)
        return [
            device.copy()
            for device in sorted(
                _registered_devices.get(scope, {}).values(),
                key=lambda item: item.get("last_seen_ts", 0),
                reverse=True,
            )
        ]


def get_state(
    scope: str,
    exclude_device_id: Optional[str] = None,
    device_id: Optional[str] = None,
) -> Optional[dict[str, Any]]:
    """
    Return playback state for this scope.
    If exclude_device_id is set, prefer returning state from another (active) device.
    Otherwise or if no other device active, return persisted file state.
    """
    with _lock:
        _ensure_scope(scope)
        _cleanup_scope(scope)
        now = time.time()

        if device_id:
            data = _active_devices.get(scope, {}).get(device_id)
            if data and (now - data.get("last_seen_ts", 0)) <= ACTIVE_DEVICE_TTL_SEC:
                return {
                    "track_id": data.get("track_id"),
                    "track": data.get("track"),
                    "position_sec": data.get("position_sec", 0),
                    "is_playing": data.get("is_playing", False),
                    "device_id": device_id,
                    "device_name": data.get("device_name"),
                    "updated_at": data.get("updated_at"),
                }

        # Note: Prefer active other device if exclude_device_id given
        if exclude_device_id:
            scope_devices = _active_devices.get(scope, {})
            best = None
            best_seen = 0
            for did, data in scope_devices.items():
                if did == exclude_device_id:
                    continue
                last_seen = data.get("last_seen_ts", 0)
                if (now - last_seen) <= ACTIVE_DEVICE_CONSIDERED_RECENT_SEC and last_seen > best_seen:
                    best_seen = last_seen
                    best = {
                        "track_id": data.get("track_id"),
                        "track": data.get("track"),
                        "position_sec": data.get("position_sec", 0),
                        "is_playing": data.get("is_playing", False),
                        "device_id": did,
                        "device_name": data.get("device_name"),
                        "updated_at": data.get("updated_at"),
                    }
            if best:
                return best

        # Note: Fall back to persisted file (same device or other; client decides dialog vs auto-restore)
        path = _state_path(scope)
        if not path.exists():
            return None
        try:
            raw = path.read_text(encoding="utf-8")
            state = json.loads(raw)
        except (json.JSONDecodeError, OSError):
            return None
        updated = state.get("updated_at") or 0
        if STATE_TTL_SEC and (now - updated) > STATE_TTL_SEC:
            return None
        return state


def put_state(scope: str, payload: dict[str, Any]) -> None:
    """Persist playback state and update active_devices for this scope."""
    device_id = payload.get("device_id")
    if not device_id:
        return
    now = time.time()
    state = {
        "track_id": payload.get("track_id"),
        "track": payload.get("track") if isinstance(payload.get("track"), dict) else None,
        "position_sec": float(payload.get("position_sec", 0)),
        "is_playing": bool(payload.get("is_playing", False)),
        "device_id": device_id,
        "device_name": payload.get("device_name"),
        "updated_at": now,
    }
    with _lock:
        _ensure_scope(scope)
        _cleanup_scope(scope)
        registered = _registered_devices[scope].get(device_id)
        if registered:
            registered["device_name"] = payload.get("device_name") or registered.get("device_name")
            registered["last_seen_ts"] = now
        _active_devices[scope][device_id] = {
            **state,
            "device_type": registered.get("device_type") if registered else payload.get("device_type"),
            "last_seen_ts": now,
        }
    path = _state_path(scope)
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        path.write_text(json.dumps(state, indent=2), encoding="utf-8")
    except OSError:
        pass
