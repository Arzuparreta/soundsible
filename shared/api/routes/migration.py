"""Library migration API, including the legacy single-playlist endpoints."""

from __future__ import annotations

import time
import uuid
from typing import Any, List

from flask import Blueprint, jsonify, request

from shared.hardening import SCOPE_LIBRARY_READ, SCOPE_LIBRARY_WRITE, rate_limit, require_scope
from shared.migration import LibraryMatcher, ParseError, parse_export, parse_upload
from shared.migration.match import match_sources_to_library, migration_stats
from shared.migration.store import MigrationStore
from shared.telemetry import emit
from shared.user_context import require_user_id

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


def _store() -> MigrationStore:
    return MigrationStore()


def _job_or_404(store: MigrationStore, job_id: str, *, include_tracks: bool = True):
    try:
        return store.get_job(job_id, include_tracks=include_tracks)
    except KeyError:
        return None


def _candidate_payload(track, confidence: float) -> dict[str, Any]:
    return {
        "kind": "library",
        "track_id": track.id,
        "title": track.title,
        "artist": track.artist or track.album_artist,
        "album": track.album,
        "duration": int(track.duration or 0),
        "confidence": round(confidence, 5),
    }


@migration_bp.route("/api/migration/jobs", methods=["POST"])
@require_scope(SCOPE_LIBRARY_READ, allow_trusted_network=True)
@rate_limit("migration_job_upload", limit=10, window_sec=300)
def migration_job_upload():
    upload = request.files.get("file")
    if upload is None or not upload.filename:
        return jsonify({"error": "file is required"}), 400
    try:
        manifest = parse_upload(upload.filename, upload.read())
    except ParseError as exc:
        return jsonify({"error": str(exc)}), 400

    lib = _get_core_lib()
    library_tracks = list(lib.metadata.tracks) if lib.metadata else []
    matcher = LibraryMatcher(library_tracks)
    by_id = {track.id: track for track in library_tracks}
    matches = []
    for index, (source_key, source) in enumerate(manifest.tracks.items()):
        result = matcher.match(source, index)
        candidates = []
        if result.matched_track_id and result.matched_track_id in by_id:
            candidates.append(_candidate_payload(by_id[result.matched_track_id], result.confidence))
        matches.append(
            {
                "source_key": source_key,
                "matched_track_id": result.matched_track_id,
                "confidence": result.confidence,
                "auto_accept": result.auto_accept,
                "candidates": candidates,
            }
        )
    store = _store()
    job, created = store.create_job(manifest, matches)
    _emit_migration(
        "migration_job_analyzed",
        {
            "job_id": job["id"],
            "provider": manifest.provider,
            "track_count": len(manifest.tracks),
            "playlist_count": len(manifest.playlists),
            "deduplicated": not created,
        },
    )
    return jsonify({"job": job, "created": created}), 201 if created else 200


@migration_bp.route("/api/migration/jobs", methods=["GET"])
@require_scope(SCOPE_LIBRARY_READ, allow_trusted_network=True)
def migration_jobs_list():
    return jsonify({"jobs": _store().list_jobs()})


@migration_bp.route("/api/migration/jobs/<job_id>", methods=["GET"])
@require_scope(SCOPE_LIBRARY_READ, allow_trusted_network=True)
def migration_job_detail(job_id: str):
    job = _job_or_404(_store(), job_id)
    if job is None:
        return jsonify({"error": "Migration job not found"}), 404
    return jsonify({"job": job})


@migration_bp.route("/api/migration/jobs/<job_id>/start", methods=["POST"])
@require_scope(SCOPE_LIBRARY_WRITE, allow_trusted_network=True)
@rate_limit("migration_job_start", limit=20, window_sec=300)
def migration_job_start(job_id: str):
    data = request.get_json(silent=True) or {}
    store = _store()
    if _job_or_404(store, job_id, include_tracks=False) is None:
        return jsonify({"error": "Migration job not found"}), 404
    playlist_ids = data.get("playlist_ids")
    if playlist_ids is None:
        manifest = store.get_manifest(job_id)
        playlist_ids = [
            playlist.source_id
            for playlist in manifest.playlists
            if not playlist.is_favourites
        ]
    if not isinstance(playlist_ids, list):
        return jsonify({"error": "playlist_ids must be an array"}), 400
    playlist_names = data.get("playlist_names") or {}
    if not isinstance(playlist_names, dict):
        return jsonify({"error": "playlist_names must be an object"}), 400
    try:
        job = store.configure(
            job_id,
            include_library=bool(data.get("include_library", True)),
            playlist_ids=playlist_ids,
            playlist_names=playlist_names,
        )
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    from shared.migration.service import start_migration_job

    start_migration_job(job_id, require_user_id())
    _emit_migration("migration_job_started", {"job_id": job_id, "selected_tracks": job["selected_track_count"]})
    return jsonify({"job": store.get_job(job_id)}), 202


@migration_bp.route("/api/migration/jobs/<job_id>/control", methods=["POST"])
@require_scope(SCOPE_LIBRARY_WRITE, allow_trusted_network=True)
@rate_limit("migration_job_control", limit=60, window_sec=120)
def migration_job_control(job_id: str):
    data = request.get_json(silent=True) or {}
    action = str(data.get("action") or "").strip().lower()
    if action not in {"pause", "resume", "cancel", "retry"}:
        return jsonify({"error": "action must be pause, resume, cancel, or retry"}), 400
    store = _store()
    job = _job_or_404(store, job_id, include_tracks=False)
    if job is None:
        return jsonify({"error": "Migration job not found"}), 404
    if action == "pause":
        if job["state"] not in {"queued", "running"}:
            return jsonify({"error": "Only a queued or running job can be paused"}), 409
        store.set_job_state(job_id, "paused")
    elif action == "cancel":
        if job["state"] in {"completed", "cancelled"}:
            return jsonify({"error": "This job has already finished"}), 409
        store.set_job_state(job_id, "cancelled")
    else:
        if action == "retry":
            store.reset_retryable(job_id)
        elif job["state"] not in {"paused", "needs_review", "partial", "failed"}:
            return jsonify({"error": "This job cannot be resumed in its current state"}), 409
        else:
            store.set_job_state(job_id, "queued")
        from shared.migration.service import start_migration_job

        start_migration_job(job_id, require_user_id())
    _emit_migration("migration_job_controlled", {"job_id": job_id, "action": action})
    return jsonify({"job": store.get_job(job_id)})


@migration_bp.route("/api/migration/jobs/<job_id>/decision", methods=["POST"])
@require_scope(SCOPE_LIBRARY_WRITE, allow_trusted_network=True)
@rate_limit("migration_job_decision", limit=240, window_sec=120)
def migration_job_decision(job_id: str):
    data = request.get_json(silent=True) or {}
    source_key = str(data.get("source_key") or "").strip()
    decision = str(data.get("decision") or "").strip().lower()
    if not source_key:
        return jsonify({"error": "source_key is required"}), 400
    if decision not in {"use_library_track", "use_candidate", "skip"}:
        return jsonify({"error": "Unsupported decision"}), 400
    store = _store()
    try:
        row = store.get_track(job_id, source_key)
    except KeyError:
        return jsonify({"error": "Migration track not found"}), 404
    if decision == "skip":
        store.update_track(job_id, source_key, state="skipped", selected={"kind": "skip"})
    elif decision == "use_library_track":
        track_id = str(data.get("track_id") or "").strip()
        if not track_id:
            return jsonify({"error": "track_id is required"}), 400
        lib = _get_core_lib()
        if not lib.metadata or not lib.metadata.get_track_by_id(track_id):
            return jsonify({"error": "Unknown library track"}), 400
        store.update_track(
            job_id,
            source_key,
            state="existing",
            matched_track_id=track_id,
            confidence=1.0,
            selected={"kind": "library", "track_id": track_id},
        )
    else:
        candidate = data.get("candidate")
        if not isinstance(candidate, dict) or not candidate.get("video_id"):
            return jsonify({"error": "candidate with video_id is required"}), 400
        clean_candidate = {
            key: candidate.get(key)
            for key in ("video_id", "title", "artist", "album", "duration", "thumbnail")
            if candidate.get(key) is not None
        }
        store.update_track(
            job_id,
            source_key,
            state="pending",
            selected={"kind": "catalog", **clean_candidate},
        )
    _emit_migration(
        "migration_track_decided",
        {"job_id": job_id, "source_key": source_key[:200], "decision": decision, "previous_state": row["state"]},
    )
    return jsonify({"job": store.get_job(job_id)})


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

    from shared.api import emit_to_user

    emit_to_user("library_updated")

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
