"""Remote command dispatcher and session transfer."""

from __future__ import annotations

import logging
from typing import Any, Callable, Optional

from socketio.exceptions import DisconnectedError, TimeoutError as SocketIOTimeoutError

from shared.playback_state import get_device_target, get_state
from shared.realtime import socketio
from shared.remote.validator import validate_command

logger = logging.getLogger(__name__)

DEFAULT_COMMAND_TIMEOUT_SEC = 5.0
IMPORT_COMMAND_TIMEOUT_SEC = 10.0

DeliverFn = Callable[[str, dict[str, Any], float], Any]


def _default_deliver(sid: str, payload: dict[str, Any], timeout: float) -> Any:
    return socketio.call("device_command", payload, to=sid, timeout=timeout)


def _rejected(http_status: int, reason: str, **extra: Any) -> tuple[int, dict[str, Any]]:
    body: dict[str, Any] = {"status": "rejected", "reason": reason}
    body.update(extra)
    return http_status, body


def _unreachable(http_status: int, reason: str, **extra: Any) -> tuple[int, dict[str, Any]]:
    body: dict[str, Any] = {"status": "unreachable", "reason": reason}
    body.update(extra)
    return http_status, body


def send_command(
    scope: str,
    device_id: str,
    name: Any,
    args: Any = None,
    *,
    allow_internal: bool = False,
    deliver: Optional[DeliverFn] = None,
) -> tuple[int, dict[str, Any]]:
    """Validate and send one remote command to a device's owning instance."""
    try:
        cmd_name, validated_args = validate_command(name, args, allow_internal=allow_internal)
    except ValueError:
        return _rejected(400, "invalid")

    normalized_device_id = str(device_id or "").strip()
    if not normalized_device_id:
        return _rejected(404, "unknown_device")

    target = get_device_target(scope, normalized_device_id)
    if target is None:
        return _rejected(404, "unknown_device")

    owner = target.get("owning_instance")
    if not target.get("online") or not owner or not owner.get("sid"):
        return _unreachable(503, "offline")

    if owner.get("protocol") is None:
        return _rejected(409, "update_required")

    declared = owner.get("commands") or ()
    if cmd_name not in declared:
        return _rejected(409, "unsupported")

    timeout = IMPORT_COMMAND_TIMEOUT_SEC if cmd_name == "session.import" else DEFAULT_COMMAND_TIMEOUT_SEC
    deliver_fn = deliver or _default_deliver
    payload = {"name": cmd_name, "args": validated_args}

    try:
        ack = deliver_fn(owner["sid"], payload, timeout)
    except (SocketIOTimeoutError, TimeoutError):
        return _unreachable(504, "timeout")
    except (DisconnectedError, KeyError):
        return _unreachable(503, "offline")

    if isinstance(ack, dict) and ack.get("status") == "applied":
        body: dict[str, Any] = {"status": "applied"}
        if type(ack.get("rev")) is int:
            body["rev"] = ack["rev"]
        if allow_internal and "state" in ack:
            body["state"] = ack["state"]
        return 200, body

    if isinstance(ack, dict) and ack.get("status") == "rejected":
        raw_reason = ack.get("reason")
        reason = raw_reason if isinstance(raw_reason, str) and raw_reason.strip() else "invalid_state"
        return _rejected(409, reason)

    return _rejected(409, "invalid_state")


def _state_has_track(state: Any) -> bool:
    if not isinstance(state, dict):
        return False
    track_id = state.get("track_id")
    if isinstance(track_id, str) and track_id.strip():
        return True
    track = state.get("track")
    return isinstance(track, dict) and bool(track.get("id"))


def transfer_playback(
    scope: str,
    from_device_id: Any,
    to_device_id: Any,
    *,
    deliver: Optional[DeliverFn] = None,
) -> tuple[int, dict[str, Any]]:
    """Move a playback session from one device to another in contract order."""
    source_id = str(from_device_id or "").strip() if isinstance(from_device_id, str) else ""
    target_id = str(to_device_id or "").strip() if isinstance(to_device_id, str) else ""
    if not source_id or not target_id or source_id == target_id:
        return _rejected(400, "invalid")

    # 1. Export from source (or fall back to stored state when offline / no protocol).
    source_target = get_device_target(scope, source_id)
    exported_state: Optional[dict[str, Any]] = None

    if source_target is not None and source_target.get("online") and (source_target.get("owning_instance") or {}).get("protocol") is not None:
        exp_status, exp_body = send_command(
            scope,
            source_id,
            "session.export",
            {},
            allow_internal=True,
            deliver=deliver,
        )
        if exp_status == 200:
            candidate = exp_body.get("state")
            if isinstance(candidate, dict):
                exported_state = dict(candidate)
                # Preserve stored session if export omitted the key (delta rule).
                if "session" not in exported_state:
                    stored = get_state(scope, device_id=source_id)
                    if isinstance(stored, dict) and "session" in stored:
                        exported_state["session"] = stored["session"]
        elif exp_body.get("reason") in {"offline", "update_required"}:
            exported_state = get_state(scope, device_id=source_id)
        else:
            return exp_status, {**exp_body, "step": "export"}
    else:
        exported_state = get_state(scope, device_id=source_id)
        if source_target is None and exported_state is None:
            return _rejected(404, "unknown_device", step="export")

    if not _state_has_track(exported_state):
        return _rejected(409, "nothing_playing", step="export")

    # 2. Import on target (10 s). Any failure leaves the source untouched.
    imp_status, imp_body = send_command(
        scope,
        target_id,
        "session.import",
        {"state": exported_state},
        allow_internal=True,
        deliver=deliver,
    )
    if imp_status != 200:
        return imp_status, {**imp_body, "step": "import"}

    # 3. Release source only after import succeeded, when the source is online.
    refreshed_source = get_device_target(scope, source_id)
    if refreshed_source is not None and refreshed_source.get("online"):
        try:
            rel_status, rel_body = send_command(
                scope,
                source_id,
                "session.release",
                {},
                allow_internal=True,
                deliver=deliver,
            )
            if rel_status != 200:
                logger.warning(
                    "Remote transfer: session.release on %s returned %s (%s)",
                    source_id,
                    rel_status,
                    rel_body,
                )
        except Exception:
            logger.warning("Remote transfer: session.release on %s failed", source_id, exc_info=True)

    return 200, imp_body
