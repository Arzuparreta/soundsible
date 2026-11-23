"""
Playback state for cross-device resume and remote control, scoped per user.
Persists last playback state and tracks registered devices and instances per scope.

The scope *is* the user id: two people on the same LAN never see each other's
devices, resume prompts, or transfer targets.
"""
from __future__ import annotations

import itertools
import json
import logging
import math
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Optional

from shared.atomic_file import publish, text_pieces
from shared.user_context import current_user_id, user_config_dir

logger = logging.getLogger(__name__)

DEFAULT_SCOPE = "default"
# Note: A published session — queue, transport preferences, Auto Mode workspace —
# is bounded by the client, which keeps a window rather than a whole history.
# This is the backstop that keeps a client which does not from filling a disk.
MAX_SESSION_BYTES = 256 * 1024
MAX_LIVE_BYTES = 16 * 1024
ACTIVE_DEVICE_TTL_SEC = 90
ACTIVE_DEVICE_CONSIDERED_RECENT_SEC = 60
STATE_TTL_SEC = 24 * 3600  # Note: 24H optional; state older can be ignored on GET

ALLOWED_DEVICE_TYPES = frozenset({"web", "desktop", "android", "ios", "agent", "car", "mobile"})
ALLOWED_FORM_FACTORS = frozenset({"phone", "tablet", "computer"})

_lock = threading.Lock()
_active_devices: dict[str, dict[str, dict[str, Any]]] = {}  # Scope -> device_id -> state
_registered_devices: dict[str, dict[str, dict[str, Any]]] = {}  # Scope -> device_id -> metadata & instances
_socket_devices: dict[str, tuple[str, str, str]] = {}  # Socket.IO sid -> (scope, device_id, instance_id)
_device_revs: dict[tuple[str, str], int] = {}  # (scope, device_id) -> monotonic revision
_instance_seqs: dict[tuple[str, str], dict[str, int]] = {}  # (scope, device_id) -> {instance_id: last_seq}
_last_playing_instances: dict[tuple[str, str], str] = {}  # (scope, device_id) -> instance_id
_connect_order = itertools.count(1)
# Every state taken under `_lock` gets the next number; only the newest one per
# scope is written, so two requests finishing out of order cannot leave the
# older state on disk.
_state_numbers = itertools.count(1)
_newest_state: dict[str, int] = {}
_persist_lock = threading.Lock()


def reset_state() -> None:
    """Clear all in-memory playback and device registries (used in tests)."""
    with _lock:
        _active_devices.clear()
        _registered_devices.clear()
        _socket_devices.clear()
        _device_revs.clear()
        _instance_seqs.clear()
        _last_playing_instances.clear()
        _newest_state.clear()


def _state_path(scope: str) -> Path:
    """Where a scope's persisted state lives.

    A scope is a user id, so the file goes in that user's directory. The legacy
    ``default`` scope only appears in tests and pre-account code paths.
    """
    if scope == DEFAULT_SCOPE:
        from shared.runtime import get_config_dir

        return get_config_dir() / f"playback_state_{scope}.json"
    return user_config_dir(scope) / "playback_state.json"


def _device_is_online_locked(scope: str, device_id: str) -> bool:
    device = _registered_devices.get(scope, {}).get(device_id)
    return bool(device and device.get("instances"))


def _cleanup_scope(scope: str) -> None:
    """Remove offline devices/registrations with last_seen older than ACTIVE_DEVICE_TTL_SEC."""
    now = time.time()
    to_drop = [
        device_id
        for device_id, data in _active_devices.get(scope, {}).items()
        if not _device_is_online_locked(scope, device_id)
        and (now - data.get("last_seen_ts", 0)) > ACTIVE_DEVICE_TTL_SEC
    ]
    for device_id in to_drop:
        _active_devices[scope].pop(device_id, None)
    registered_to_drop = [
        device_id
        for device_id, data in _registered_devices.get(scope, {}).items()
        if not data.get("instances") and (now - data.get("last_seen_ts", 0)) > ACTIVE_DEVICE_TTL_SEC
    ]
    for device_id in registered_to_drop:
        _registered_devices[scope].pop(device_id, None)


def _ensure_scope(scope: str) -> None:
    if scope not in _active_devices:
        _active_devices[scope] = {}
    if scope not in _registered_devices:
        _registered_devices[scope] = {}


def get_scope_from_request() -> str:
    """Resolve the playback scope for the caller — the bound user id.

    Falls back to ``default`` only outside a bound context (tests, boot-time
    warmup), which keeps the pre-account behaviour intact.
    """
    return current_user_id() or DEFAULT_SCOPE


def _normalize_device_type(device_type: Optional[str], fallback: str = "desktop") -> str:
    if isinstance(device_type, str):
        candidate = device_type.strip().lower()
        if candidate in ALLOWED_DEVICE_TYPES:
            return candidate
    return fallback


def _normalize_form_factor(form_factor: Optional[str], fallback: Optional[str] = None) -> Optional[str]:
    if isinstance(form_factor, str):
        candidate = form_factor.strip().lower()
        if candidate in ALLOWED_FORM_FACTORS:
            return candidate
    return fallback


def _sanitize_commands(commands: Any) -> list[str]:
    if not isinstance(commands, list):
        return []
    seen: set[str] = set()
    cleaned: list[str] = []
    for item in commands:
        if isinstance(item, str):
            name = item.strip()
            if name and len(name) <= 128 and name not in seen:
                seen.add(name)
                cleaned.append(name)
    return cleaned


def _playing_mode(
    track: Optional[dict[str, Any]],
    live: Optional[dict[str, Any]],
    session: Optional[dict[str, Any]],
) -> str:
    if isinstance(live, dict) and live.get("dj") is not None:
        return "dj"
    if isinstance(session, dict) and session.get("mode") == "auto":
        return "dj"
    if isinstance(session, dict):
        radio = session.get("radio")
        if isinstance(radio, dict) and radio.get("active"):
            return "radio"
    if isinstance(track, dict) and (
        track.get("media_kind") == "podcast_episode"
        or bool(track.get("podcast_episode_guid"))
        or bool(track.get("podcast_enclosure_url"))
    ):
        return "podcast"
    return "normal"


def _owning_instance_locked(scope: str, device_id: str, device: dict[str, Any]) -> Optional[dict[str, Any]]:
    instances: dict[str, dict[str, Any]] = device.get("instances") or {}
    if not instances:
        return None
    last_playing = _last_playing_instances.get((scope, device_id))
    if last_playing and last_playing in instances:
        return instances[last_playing]
    return max(instances.values(), key=lambda inst: (inst["connected_at"], inst["connect_order"]))


def _device_row_locked(scope: str, device_id: str) -> Optional[dict[str, Any]]:
    device = _registered_devices.get(scope, {}).get(device_id)
    if not device:
        return None
    owner = _owning_instance_locked(scope, device_id, device)
    online = owner is not None
    active = _active_devices.get(scope, {}).get(device_id)
    playing: Optional[dict[str, Any]] = None
    if isinstance(active, dict) and (active.get("track_id") or isinstance(active.get("track"), dict)):
        track = active.get("track")
        if not isinstance(track, dict) and active.get("track_id"):
            track = {"id": active["track_id"]}
        playing = {
            "track": track,
            "is_playing": bool(active.get("is_playing", False)),
            "position_sec": active.get("position_sec", 0.0),
            "measured_at_ms": active.get("measured_at_ms"),
            "mode": _playing_mode(track, active.get("live"), active.get("session")),
            "rev": active.get("rev", _device_revs.get((scope, device_id), 0)),
        }
    return {
        "device_id": device["device_id"],
        "device_name": device["device_name"],
        "device_type": device["device_type"],
        "form_factor": device.get("form_factor"),
        "online": online,
        "socket_active": online,
        "protocol": owner["protocol"] if owner else None,
        "commands": list(owner["commands"]) if owner else [],
        "playing": playing,
    }


def _upsert_device_locked(
    scope: str,
    *,
    device_id: Optional[str] = None,
    device_name: Optional[str] = None,
    device_type: Optional[str] = None,
    form_factor: Optional[str] = None,
    now: float,
) -> dict[str, Any]:
    normalized_device_id = str(device_id or "").strip() or str(uuid.uuid4())
    existing = _registered_devices[scope].get(normalized_device_id)
    cleaned_name = str(device_name).strip() if isinstance(device_name, str) and device_name.strip() else None
    if existing:
        existing["device_name"] = cleaned_name or existing["device_name"]
        if device_type is not None:
            existing["device_type"] = _normalize_device_type(device_type, fallback=existing["device_type"])
        if form_factor is not None:
            existing["form_factor"] = _normalize_form_factor(form_factor, fallback=existing.get("form_factor"))
        existing["last_seen_ts"] = now
        device = existing
    else:
        device = {
            "device_id": normalized_device_id,
            "device_name": cleaned_name or normalized_device_id,
            "device_type": _normalize_device_type(device_type, fallback="desktop"),
            "form_factor": _normalize_form_factor(form_factor, fallback=None),
            "scope": scope,
            "last_seen_ts": now,
            "registered_at": now,
            "instances": {},
        }
        _registered_devices[scope][normalized_device_id] = device
    active = _active_devices[scope].get(normalized_device_id)
    if active:
        active["device_name"] = device["device_name"]
        active["device_type"] = device["device_type"]
        active["last_seen_ts"] = now
    return device


def register_device(
    scope: str,
    *,
    device_id: Optional[str] = None,
    device_name: Optional[str] = None,
    device_type: Optional[str] = None,
    form_factor: Optional[str] = None,
) -> dict[str, Any]:
    """Register or refresh a device in a scope and return its row."""
    now = time.time()
    with _lock:
        _ensure_scope(scope)
        _cleanup_scope(scope)
        device = _upsert_device_locked(
            scope,
            device_id=device_id,
            device_name=device_name,
            device_type=device_type,
            form_factor=form_factor,
            now=now,
        )
        return _device_row_locked(scope, device["device_id"])  # type: ignore[return-value]


def _detach_socket_locked(sid: str, now: float) -> Optional[tuple[str, str]]:
    bound = _socket_devices.pop(sid, None)
    if not bound:
        return None
    old_scope, old_device_id, old_instance_id = bound
    old_device = _registered_devices.get(old_scope, {}).get(old_device_id)
    if not old_device:
        return None
    inst = (old_device.get("instances") or {}).get(old_instance_id)
    if inst and inst.get("sid") == sid:
        old_device["instances"].pop(old_instance_id, None)
        old_device["last_seen_ts"] = now
        return old_scope, old_device_id
    return None


def register_socket_instance(
    scope: str,
    device_id: str,
    sid: str,
    *,
    device_name: Optional[str] = None,
    device_type: Optional[str] = None,
    form_factor: Optional[str] = None,
    instance_id: Optional[str] = None,
    protocol: Any = None,
    commands: Any = None,
) -> tuple[Optional[dict[str, Any]], Optional[tuple[str, dict[str, Any]]]]:
    """Bind a connected Socket.IO instance to a device.

    Returns ``(device_row, previous_device_update)`` where the second item is
    non-None when this socket moved away from a different device.
    """
    normalized_device_id = str(device_id or "").strip()
    if not normalized_device_id or not sid:
        return None, None
    now = time.time()
    with _lock:
        _ensure_scope(scope)
        _cleanup_scope(scope)

        moved_from: Optional[tuple[str, str]] = None
        previous_binding = _socket_devices.get(sid)
        if previous_binding:
            detached = _detach_socket_locked(sid, now)
            if detached and detached != (scope, normalized_device_id):
                moved_from = detached

        device = _upsert_device_locked(
            scope,
            device_id=normalized_device_id,
            device_name=device_name,
            device_type=device_type,
            form_factor=form_factor,
            now=now,
        )

        has_instance_id = isinstance(instance_id, str) and bool(instance_id.strip())
        if has_instance_id:
            norm_instance_id = instance_id.strip()
            norm_protocol = protocol if (type(protocol) is int and protocol >= 1) else None
            norm_commands = _sanitize_commands(commands) if norm_protocol is not None else []
        else:
            # Older app without instance_id: socket id is the instance id and protocol is null.
            norm_instance_id = sid
            norm_protocol = None
            norm_commands = []

        instances = device.setdefault("instances", {})
        replaced = instances.get(norm_instance_id)
        if replaced and replaced.get("sid") and replaced["sid"] != sid:
            _socket_devices.pop(replaced["sid"], None)

        last_seq = _instance_seqs.get((scope, normalized_device_id), {}).get(norm_instance_id)
        instances[norm_instance_id] = {
            "sid": sid,
            "instance_id": norm_instance_id,
            "protocol": norm_protocol,
            "commands": norm_commands,
            "connected_at": now,
            "connect_order": next(_connect_order),
            "last_seq": last_seq,
        }
        _socket_devices[sid] = (scope, normalized_device_id, norm_instance_id)

        old_update: Optional[tuple[str, dict[str, Any]]] = None
        if moved_from:
            old_row = _device_row_locked(moved_from[0], moved_from[1])
            if old_row:
                old_update = (moved_from[0], old_row)
        return _device_row_locked(scope, normalized_device_id), old_update


def unregister_socket(sid: str) -> Optional[tuple[str, dict[str, Any]]]:
    """Detach a disconnected socket and return ``(scope, updated_device_row)`` if a device changed."""
    if not sid:
        return None
    now = time.time()
    with _lock:
        detached = _detach_socket_locked(sid, now)
        if not detached:
            return None
        scope, device_id = detached
        row = _device_row_locked(scope, device_id)
        if not row:
            return None
        return scope, row


def get_registered_device(scope: str, device_id: str) -> Optional[dict[str, Any]]:
    with _lock:
        _ensure_scope(scope)
        _cleanup_scope(scope)
        return _device_row_locked(scope, device_id)


def get_device_target(scope: str, device_id: str) -> Optional[dict[str, Any]]:
    """Return internal dispatch details (including owning socket sid) for a device."""
    with _lock:
        _ensure_scope(scope)
        _cleanup_scope(scope)
        device = _registered_devices.get(scope, {}).get(device_id)
        if not device:
            return None
        owner = _owning_instance_locked(scope, device_id, device)
        return {
            "device_id": device["device_id"],
            "device_name": device["device_name"],
            "online": owner is not None,
            "owning_instance": (
                {
                    "sid": owner["sid"],
                    "instance_id": owner["instance_id"],
                    "protocol": owner["protocol"],
                    "commands": tuple(owner["commands"]),
                }
                if owner
                else None
            ),
        }


def resolve_registered_device(scope: str, identifier: str) -> Optional[dict[str, Any]]:
    normalized = str(identifier or "").strip()
    if not normalized:
        return None
    with _lock:
        _ensure_scope(scope)
        _cleanup_scope(scope)
        devices = _registered_devices.get(scope, {})
        if normalized in devices:
            return _device_row_locked(scope, normalized)
        folded = normalized.casefold()
        matches = [
            device
            for device in devices.values()
            if str(device.get("device_name") or "").casefold() == folded
        ]
        if not matches:
            return None
        matches.sort(
            key=lambda item: (
                1 if item.get("instances") else 0,
                item.get("last_seen_ts", 0),
            ),
            reverse=True,
        )
        return _device_row_locked(scope, matches[0]["device_id"])


def list_registered_devices(scope: str) -> list[dict[str, Any]]:
    with _lock:
        _ensure_scope(scope)
        _cleanup_scope(scope)
        ordered = sorted(
            _registered_devices.get(scope, {}).values(),
            key=lambda item: item.get("last_seen_ts", 0),
            reverse=True,
        )
        rows = []
        for device in ordered:
            row = _device_row_locked(scope, device["device_id"])
            if row:
                rows.append(row)
        return rows


def list_registered_devices_debug(scope: str) -> list[dict[str, Any]]:
    """Detailed view of devices and connected instances for the debug endpoint."""
    with _lock:
        _ensure_scope(scope)
        _cleanup_scope(scope)
        ordered = sorted(
            _registered_devices.get(scope, {}).values(),
            key=lambda item: item.get("last_seen_ts", 0),
            reverse=True,
        )
        result = []
        for device in ordered:
            owner = _owning_instance_locked(scope, device["device_id"], device)
            result.append({
                "device_id": device["device_id"],
                "device_name": device["device_name"],
                "device_type": device["device_type"],
                "form_factor": device.get("form_factor"),
                "online": owner is not None,
                "last_seen_ts": device.get("last_seen_ts"),
                "owning_instance_id": owner["instance_id"] if owner else None,
                "active_sid": owner["sid"] if owner else None,
                "instances": [
                    {
                        "instance_id": inst["instance_id"],
                        "sid": inst["sid"],
                        "protocol": inst["protocol"],
                        "commands_count": len(inst["commands"]),
                        "connected_at": inst["connected_at"],
                        "last_seq": inst["last_seq"],
                    }
                    for inst in (device.get("instances") or {}).values()
                ],
            })
        return result


def _sanitize_bounded_object(value: Any, max_bytes: int) -> Optional[dict[str, Any]]:
    if not isinstance(value, dict):
        return None
    try:
        encoded = json.dumps(value)
    except (TypeError, ValueError):
        return None
    if len(encoded.encode("utf-8")) > max_bytes:
        return None
    return value


def _sanitize_session(value: Any) -> Optional[dict[str, Any]]:
    """A session payload worth storing, or None."""
    return _sanitize_bounded_object(value, MAX_SESSION_BYTES)


def _sanitize_live(value: Any) -> Optional[dict[str, Any]]:
    """A live payload worth storing, or None."""
    return _sanitize_bounded_object(value, MAX_LIVE_BYTES)


def _stored_session(scope: str, device_id: str) -> Optional[dict[str, Any]]:
    """The session already held for a device. Call with the lock held."""
    active = _active_devices.get(scope, {}).get(device_id)
    if isinstance(active, dict):
        session = active.get("session")
        return session if isinstance(session, dict) else None
    # No memory of this device at all: a restarted engine, whose only memory is
    # the file. Every later ping is answered from the entry this one rebuilds.
    path = _state_path(scope)
    if not path.exists():
        return None
    try:
        persisted = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None
    if not isinstance(persisted, dict) or persisted.get("device_id") != device_id:
        return None
    session = persisted.get("session")
    return session if isinstance(session, dict) else None


def get_watch_state(scope: str, device_id: str) -> Optional[dict[str, Any]]:
    """Full stored playback state (including session) for a ``watch_device`` ack."""
    with _lock:
        _ensure_scope(scope)
        _cleanup_scope(scope)
        data = _active_devices.get(scope, {}).get(device_id)
        if isinstance(data, dict):
            return {
                "device_id": device_id,
                "rev": data.get("rev", _device_revs.get((scope, device_id), 0)),
                "track_id": data.get("track_id"),
                "track": data.get("track"),
                "position_sec": data.get("position_sec", 0.0),
                "is_playing": bool(data.get("is_playing", False)),
                "measured_at_ms": data.get("measured_at_ms"),
                "live": data.get("live"),
                "session": data.get("session"),
            }
        return None


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
            if data and (
                _device_is_online_locked(scope, device_id)
                or (now - data.get("last_seen_ts", 0)) <= ACTIVE_DEVICE_TTL_SEC
            ):
                return {
                    "track_id": data.get("track_id"),
                    "track": data.get("track"),
                    "position_sec": data.get("position_sec", 0),
                    "is_playing": data.get("is_playing", False),
                    "device_id": device_id,
                    "device_name": data.get("device_name"),
                    "session": data.get("session"),
                    "live": data.get("live"),
                    "measured_at_ms": data.get("measured_at_ms"),
                    "rev": data.get("rev"),
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
                if (
                    _device_is_online_locked(scope, did)
                    or (now - last_seen) <= ACTIVE_DEVICE_CONSIDERED_RECENT_SEC
                ) and last_seen > best_seen:
                    best_seen = last_seen
                    best = {
                        "track_id": data.get("track_id"),
                        "track": data.get("track"),
                        "position_sec": data.get("position_sec", 0),
                        "is_playing": data.get("is_playing", False),
                        "device_id": did,
                        "device_name": data.get("device_name"),
                        "session": data.get("session"),
                        "live": data.get("live"),
                        "measured_at_ms": data.get("measured_at_ms"),
                        "rev": data.get("rev"),
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
        if device_id and state.get("device_id") != device_id:
            return None
        if exclude_device_id and state.get("device_id") != exclude_device_id:
            return None
        return state


def put_state(scope: str, payload: dict[str, Any]) -> Optional[dict[str, Any]]:
    """Persist playback state and update active_devices for this scope.

    ``session`` is a delta: omitting the key keeps the stored session, an
    explicit ``null`` clears it. ``live`` is replaced on every publication.
    If ``instance_id`` and an integer ``seq`` are provided and ``seq`` is not
    strictly greater than the last accepted ``seq`` for that instance, the
    publication is dropped and ``{"status": "stale"}`` is returned.
    """
    device_id = str(payload.get("device_id") or "").strip() if isinstance(payload, dict) else ""
    if not device_id:
        return None
    raw_instance_id = payload.get("instance_id")
    instance_id = raw_instance_id.strip() if isinstance(raw_instance_id, str) and raw_instance_id.strip() else None
    seq = payload.get("seq")
    has_seq = type(seq) is int

    now = time.time()
    measured_at_ms = int(round(now * 1000))
    try:
        raw_pos = float(payload.get("position_sec", 0) or 0)
        position_sec = raw_pos if math.isfinite(raw_pos) and raw_pos >= 0 else 0.0
    except (TypeError, ValueError):
        position_sec = 0.0

    track_id = payload.get("track_id")
    track = payload.get("track") if isinstance(payload.get("track"), dict) else None
    is_playing = bool(payload.get("is_playing", False))
    has_session_key = "session" in payload
    live = _sanitize_live(payload.get("live"))

    with _lock:
        _ensure_scope(scope)
        _cleanup_scope(scope)

        if instance_id is not None and has_seq:
            seqs = _instance_seqs.setdefault((scope, device_id), {})
            last_seq = seqs.get(instance_id)
            if last_seq is not None and seq <= last_seq:
                return {"status": "stale"}
            seqs[instance_id] = seq
            reg_device = _registered_devices[scope].get(device_id)
            if reg_device and instance_id in (reg_device.get("instances") or {}):
                reg_device["instances"][instance_id]["last_seq"] = seq

        rev = _device_revs.get((scope, device_id), 0) + 1
        _device_revs[(scope, device_id)] = rev

        session = (
            _stored_session(scope, device_id)
            if not has_session_key
            else _sanitize_session(payload.get("session"))
        )

        if instance_id is not None and track_id is not None and (not isinstance(track_id, str) or track_id.strip()):
            _last_playing_instances[(scope, device_id)] = instance_id

        state: dict[str, Any] = {
            "track_id": track_id,
            "track": track,
            "position_sec": position_sec,
            "is_playing": is_playing,
            "device_id": device_id,
            "device_name": payload.get("device_name"),
            "updated_at": now,
            "measured_at_ms": measured_at_ms,
            "rev": rev,
            "live": live,
        }
        if session is not None:
            state["session"] = session

        registered = _registered_devices[scope].get(device_id)
        if registered:
            if isinstance(payload.get("device_name"), str) and payload["device_name"].strip():
                registered["device_name"] = payload["device_name"].strip()
            registered["last_seen_ts"] = now

        _active_devices[scope][device_id] = {
            **state,
            "device_type": registered.get("device_type") if registered else payload.get("device_type"),
            "last_seen_ts": now,
        }
        device_row = _device_row_locked(scope, device_id)
        number = next(_state_numbers)
        _newest_state[scope] = number

    _persist_state(scope, number, json.dumps(state, indent=2))

    event_state: dict[str, Any] = {
        "device_id": device_id,
        "rev": rev,
        "track_id": track_id,
        "track": track,
        "position_sec": position_sec,
        "is_playing": is_playing,
        "measured_at_ms": measured_at_ms,
        "live": live,
        "server_now_ms": int(round(time.time() * 1000)),
    }
    if has_session_key:
        event_state["session"] = session

    return {
        "status": "ok",
        "rev": rev,
        "device_row": device_row,
        "device_state": event_state,
    }


def _persist_state(scope: str, number: int, body: str) -> None:
    """Replace the scope's file whole, unless a newer state was taken meanwhile.

    A power loss during an in-place write left a truncated file, and with it no
    resume after the restart.
    """
    with _persist_lock:
        if _newest_state.get(scope) != number:
            return  # The newer state's own call writes it.
        try:
            publish(_state_path(scope), text_pieces([body]))
        except OSError as error:
            logger.warning("playback state: could not save %s: %s", scope, error)
