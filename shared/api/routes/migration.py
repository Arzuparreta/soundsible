"""
Phase 1 migration API: preview matching against the local library and optional playlist import.
"""

from __future__ import annotations

import time
import uuid
from typing import Any, List

from flask import Blueprint, jsonify, request

from shared.hardening import SCOPE_LIBRARY_READ, SCOPE_LIBRARY_WRITE, rate_limit, require_scope
from shared.migration import ParseError, parse_export
from shared.migration.match import match_sources_to_library, migration_stats
from shared.telemetry import emit

migration_bp = Blueprint("migration", __name__, url_prefix="")


def _get_core_lib():
    from shared.api import get_core

    lib, _, _ = get_core()
    lib.refresh_if_stale()
    if not lib.metadata:
        lib.sync_library()
    return lib


def _emit_migration(kind: str, payload: dict[str, Any]) -> None:
    emit(
        "migration",
        {"v": 1, "event": kind, "ts": int(time.time()), **payload},
    )


@migration_bp.route("/api/migration/preview", methods=["POST"])
@require_scope(SCOPE_LIBRARY_READ, allow_trusted_network=True)
@rate_limit("migration_preview", limit=30, window_sec=120)
def migration_preview():
    data = request.get_json(silent=True) or {}
    fmt = data.get("format") or data.get("export_format")
    text = data.get("text") or data.get("payload") or ""
    if not fmt:
        return jsonify({"error": "format is required (e.g. spotify_json, apple_music_csv)"}), 400
    if not text or not isinstance(text, str):
        return jsonify({"error": "text (export body) is required"}), 400

    try:
        sources = parse_export(str(fmt), text)
    except ParseError as e:
        return jsonify({"error": str(e)}), 400

    lib = _get_core_lib()
    if not lib.metadata or not lib.metadata.tracks:
        return jsonify({"error": "Library has no tracks to match against"}), 409

    batch_id = str(uuid.uuid4())
    _emit_migration(
        "migration_import_preview_started",
        {"batch_id": batch_id, "format": str(fmt), "source_rows": len(sources)},
    )

    results = match_sources_to_library(sources, lib.metadata.tracks)
    stats = migration_stats(results)

    _emit_migration(
        "migration_import_preview_completed",
        {
            "batch_id": batch_id,
            "format": str(fmt),
            **stats,
        },
    )

    return jsonify(
        {
            "batch_id": batch_id,
            "format": fmt,
            "stats": stats,
            "matches": [r.to_dict() for r in results],
        }
    )


@migration_bp.route("/api/migration/import-playlist", methods=["POST"])
@require_scope(SCOPE_LIBRARY_WRITE, allow_trusted_network=True)
@rate_limit("migration_import_playlist", limit=20, window_sec=300)
def migration_import_playlist():
    """Create a playlist from confirmed track IDs (typically after preview + user confirmation)."""
    data = request.get_json(silent=True) or {}
    name = (data.get("playlist_name") or data.get("name") or "").strip()
    track_ids = data.get("track_ids") or data.get("tracks")
    if not name:
        return jsonify({"error": "playlist_name is required"}), 400
    if not isinstance(track_ids, list) or not track_ids:
        return jsonify({"error": "track_ids must be a non-empty array"}), 400

    cleaned: List[str] = []
    for x in track_ids:
        if isinstance(x, str) and x.strip():
            cleaned.append(x.strip())
        elif isinstance(x, dict) and x.get("track_id"):
            cleaned.append(str(x["track_id"]).strip())

    if not cleaned:
        return jsonify({"error": "No valid track IDs"}), 400

    lib = _get_core_lib()
    if not lib.metadata:
        return jsonify({"error": "Library not loaded"}), 409

    if name in lib.metadata.playlists:
        return jsonify({"error": "Playlist already exists", "playlist_name": name}), 409

    missing = [tid for tid in cleaned if not lib.metadata.get_track_by_id(tid)]
    if missing:
        return jsonify({"error": "Unknown track IDs", "missing": missing[:50]}), 400

    lib.metadata.create_playlist(name, track_ids=[])
    for tid in cleaned:
        lib.metadata.add_to_playlist(name, tid)
    lib._save_metadata()

    from shared.api import socketio

    socketio.emit("library_updated")

    batch_id = data.get("batch_id")
    apply_payload: dict[str, Any] = {
        "playlist_name": name,
        "track_count": len(cleaned),
    }
    if isinstance(batch_id, str) and batch_id.strip():
        apply_payload["batch_id"] = batch_id.strip()[:128]

    _emit_migration("migration_import_apply", apply_payload)

    return jsonify(
        {
            "status": "success",
            "playlist_name": name,
            "track_count": len(cleaned),
            "playlists": lib.metadata.playlists,
            "settings": lib.metadata.settings,
        }
    )


@migration_bp.route("/api/migration/row-decision", methods=["POST"])
@require_scope(SCOPE_LIBRARY_WRITE, allow_trusted_network=True)
@rate_limit("migration_row_decision", limit=120, window_sec=120)
def migration_row_decision():
    """Telemetry hook for import repair UX: user confirms or rejects a matched/unmatched row."""
    data = request.get_json(silent=True) or {}
    batch_id = (data.get("batch_id") or "").strip()
    if not batch_id:
        return jsonify({"error": "batch_id is required"}), 400
    try:
        source_index = int(data.get("source_index"))
    except (TypeError, ValueError):
        return jsonify({"error": "source_index must be an integer"}), 400
    decision = (data.get("decision") or "").strip().lower()
    if decision not in {"confirm", "reject", "skip"}:
        return jsonify({"error": "decision must be confirm, reject, or skip"}), 400
    track_id = data.get("track_id")
    tid = str(track_id).strip()[:128] if track_id is not None and str(track_id).strip() else None

    _emit_migration(
        "migration_row_decision",
        {
            "batch_id": batch_id[:128],
            "source_index": source_index,
            "decision": decision,
            **({"track_id": tid} if tid else {}),
        },
    )
    return jsonify({"status": "ok"})
