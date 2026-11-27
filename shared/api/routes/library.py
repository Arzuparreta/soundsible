from shared.library_lifecycle import serialized
from hashlib import sha256
"""
Library, metadata, playlists, favourites, and cover routes.
"""

import logging
from urllib.parse import unquote

from flask import Blueprint, request, jsonify
from shared import catalog_resolution
from shared.hardening import SCOPE_ADMIN_DANGEROUS, SCOPE_LIBRARY_WRITE, rate_limit, require_scope
from shared.user_context import require_user_id

from shared.loudness import annotate_tracks

logger = logging.getLogger(__name__)

library_bp = Blueprint("library", __name__, url_prefix="")


@library_bp.after_request
def collection_contract(response):
    response.headers['X-Soundsible-Collection'] = 'true'
    response.headers.add('Access-Control-Expose-Headers', 'ETag, X-Soundsible-Collection')
    return response


def _lyrics_payload(
    record=None,
    *,
    cached=False,
    status=None,
    source_kind=None,
    audio_duration=None,
    offset_ms=None,
    enriching=False,
):
    """What a player needs to show lyrics, and whether their timing can be trusted.

    ``timing_safe`` says whether timed lines can be followed as they are: the
    upload is a class whose timeline matches the album's, and the recording is
    as long as the one the lines were written for.

    The two failures are answered differently. An upload whose class does not
    vouch for its timeline (a lyric video, anything unverified) is no evidence
    of a mismatch, only of not knowing, so its timed lines are withheld and the
    plain text shows — asking every such stream to be aligned by hand would be
    noise. A recording of another length *is* evidence, so its lines are sent,
    flagged, for the listener to line up with a tap. ``offset_ms`` is that
    correction, if one was made.
    """
    from shared.lyrics import display_provider, has_text, parse_rich_synced, synced_timing_fits
    from shared.music_identity import synced_lyrics_safe

    if status is None:
        status = "ready" if has_text(record) else "not_found"
    synced_duration = record.get("synced_duration") if record else None
    vouched = source_kind is None or synced_lyrics_safe(str(source_kind))
    rich_synced = parse_rich_synced(record.get("rich_synced")) if record and vouched else None
    rich_duration = rich_synced.get("dur") if isinstance(rich_synced, dict) else None
    effective_duration = rich_duration if (rich_synced and rich_duration) else synced_duration
    timing_safe = vouched and synced_timing_fits(audio_duration, effective_duration)
    return {
        "status": status,
        "synced": record.get("synced") if record and vouched else None,
        "rich_synced": rich_synced,
        "plain": record.get("plain") if record else None,
        "instrumental": bool(record and record.get("instrumental")),
        "cached": cached,
        "pending": status == "pending",
        "enriching": bool(enriching) and vouched,
        "timing_safe": timing_safe,
        "synced_duration": effective_duration,
        "offset_ms": offset_ms,
        # Who to credit beside the lines; lrc.red's terms ask for a link to it.
        "provider": display_provider(record, include_rich=vouched),
    }


def _playlist_mutation_response(metadata, status: str = "success"):
    """Stable shape for web client: playlists plus library settings (e.g. playlist_covers)."""
    return jsonify({"status": status, "playlists": metadata.playlists, "settings": metadata.settings})


def _commit_playlists(api, lib, metadata):
    """Persist a playlist change and answer with the map the engine now holds.

    A save can be refused — the canonical library moved under this snapshot, so
    writing it would undo somebody else's change. Echoing the mutated map back
    after that is worse than an error: the client renders a playlist the engine
    will not serve, and the next library sync quietly takes the song away
    again. Say it did not happen, so the client can say so too and retry.
    """
    if not lib._save_metadata(metadata=metadata):
        from shared.library_lifecycle import LibraryPersistenceError
        raise LibraryPersistenceError(getattr(lib, "last_save_error", "library_conflict"))
    api["emit_to_user"]("library_updated")
    return _playlist_mutation_response(metadata)


def _playlist_precondition(metadata, name, data):
    if "expected_track_ids" not in data:
        return None
    expected = data["expected_track_ids"]
    if not isinstance(expected, list) or not all(isinstance(value, str) for value in expected):
        return jsonify(error="expected_track_ids must be a string list"), 400
    if expected != metadata.playlists.get(name):
        return jsonify(error="Playlist changed; refresh before editing"), 409
    return None


def _get_api():
    """Lazy import from shared.api to avoid circular imports; returns a dict of core helpers and singletons."""
    from shared.api import is_trusted_network
    from shared.user_cores import get_library, get_track_by_id, ensure_library_metadata, get_favourites_manager, favourite_library_ids
    from shared.library_tasks import mark_track_metadata_updated
    from shared.realtime import socketio, emit_to_user
    from shared.download_pump import get_downloader
    from shared.models import LibraryMetadata
    return {
        "get_library": get_library,
        "get_track_by_id": get_track_by_id,
        "mark_track_metadata_updated": mark_track_metadata_updated,
        "ensure_library_metadata": ensure_library_metadata,
        "socketio": socketio,
        "emit_to_user": emit_to_user,
        "get_downloader": get_downloader,
        "favourites_manager": get_favourites_manager(),
        "favourite_library_ids": favourite_library_ids,
        "is_trusted_network": is_trusted_network,
        "LibraryMetadata": LibraryMetadata,
    }


def _library_response(response, revision):
    response.set_etag(revision, weak=True)
    response.headers["Cache-Control"] = "private, no-cache"
    response.vary.update(("Cookie", "X-Soundsible-Admin-Token"))
    if request.if_none_match.contains_weak(revision):
        response.status_code = 304
        response.set_data(b"")
    return response


def _annotation_revisions(artwork):
    from shared.loudness import LoudnessStore
    return artwork.public_revision(), LoudnessStore().public_revision()


def _held_revision(user_id, fingerprint, dependencies):
    from shared.api.library_revision import validator_key, validators

    cached = validators.get(validator_key(user_id, fingerprint, dependencies))
    return cached if cached and request.if_none_match.contains_weak(cached) else None


def _try_fast_library_response(db, artwork, user_id, base):
    """Answer conditional 304s or verified journal deltas without loading all tracks."""
    from flask import Response
    from shared.api import library_incremental

    try:
        source, read_stamp, has_tracks = db.public_read_state()
        state = library_incremental.prepare(source, artwork)
        if state is not None:
            revision = library_incremental.revision_for(user_id, state)
            if request.if_none_match.contains_weak(revision):
                return _library_response(Response(), revision), state
            if base:
                partial = library_incremental.try_delta(db, artwork, user_id, base, state)
                if partial is not None:
                    return partial, state
        elif read_stamp is not None and request.if_none_match:
            dependencies_now = _annotation_revisions(artwork) if has_tracks else ()
            held = _held_revision(user_id, read_stamp, dependencies_now)
            if held:
                return _library_response(Response(), held), None
        return None, state
    except Exception:
        logger.debug("Incremental library read unavailable; using full snapshot", exc_info=True)
        return None, None


def _prepare_incremental_state(source, artwork, previous=None):
    from shared.api import library_incremental

    if previous is not None and previous["source"] == source:
        return previous
    try:
        return library_incremental.prepare(source, artwork)
    except Exception:
        return None


def _finalize_content_library_response(
    payload, user_id, artwork, base, wants_delta, dependencies, snapshot_fingerprint, loudness_ok
):
    """Serve content-hashed ETag validation and legacy row-hash deltas when journal proofs cannot."""
    from shared.api.library_revision import validator_key, validators

    tracks = payload.get("tracks") or []
    response = None
    signature = None
    if base:
        from shared.api.library_serialization import compact_signature
        signature = compact_signature(payload, user_id)
    if signature is None:
        response = jsonify(payload)
        digest = sha256(user_id.encode() + b"\0")
        digest.update(response.get_data())
        revision, full_size = digest.hexdigest(), len(response.get_data())
    else:
        revision, full_size = signature
    if dependencies is not None and snapshot_fingerprint is not None and loudness_ok is True:
        try:
            # Cache only the detached content under an unchanged annotation token.
            current_dependencies = _annotation_revisions(artwork) if tracks else ()
            if current_dependencies == dependencies:
                validators.put(validator_key(user_id, snapshot_fingerprint, dependencies), revision)
        except Exception:
            pass
    if wants_delta:
        try:
            from shared.api.library_deltas import exchange
            delta = exchange(user_id, revision, payload, base)
            if delta is not None:
                candidate = jsonify(delta)
                if len(candidate.get_data()) < full_size:
                    candidate.headers["Cache-Control"] = "private, no-store"
                    return candidate
        except Exception:
            logger.debug("Library delta history unavailable; sending full snapshot", exc_info=True)
    if response is None:
        response = jsonify(payload)
    return _library_response(response, revision)


@library_bp.route("/api/library", methods=["GET"])
def get_library():
    from flask import Response
    from shared.api import library_incremental
    from shared.api.library_revision import fingerprint
    from shared.artwork import artwork_store
    from shared.database import DatabaseManager
    from shared.user_context import current_user_id

    lib = _get_api()["get_library"]()
    artwork = artwork_store()
    user_id = current_user_id() or ""
    wants_delta = request.args.get("delta") == "1"
    base = request.args.get("since") if wants_delta else None
    if base and len(base) > 128:
        base = None

    db = getattr(lib, "db", None)
    payload = state = dependencies = stamp = None
    if isinstance(db, DatabaseManager):
        if request.if_none_match or base:
            fast_response, state = _try_fast_library_response(db, artwork, user_id, base)
            if fast_response is not None:
                return fast_response
        payload, source, stamp = db.public_snapshot()
        state = _prepare_incremental_state(source, artwork, state)

    if payload is None:
        lib.refresh_if_stale()
        if not lib.metadata:
            lib.sync_library()
            if isinstance(db, DatabaseManager):
                payload, source, stamp = db.public_snapshot()
                state = _prepare_incremental_state(source, artwork)

    if payload is None:
        if not lib.metadata:
            return jsonify({"error": "Library not loaded"}), 404
        try:
            dependencies = _annotation_revisions(artwork) if lib.metadata.tracks else ()
            if request.if_none_match:
                held = _held_revision(user_id, fingerprint(lib.metadata), dependencies)
                if held:
                    return _library_response(Response(), held)
        except Exception:
            dependencies = None
        payload = lib.metadata.to_public_dict()

    snapshot_fingerprint = stamp
    if stamp is not None:
        try:
            dependencies = _annotation_revisions(artwork) if payload["tracks"] else ()
        except Exception:
            dependencies = None
    elif dependencies is not None:
        try:
            snapshot_fingerprint = fingerprint(payload)
        except Exception:
            pass

    tracks = payload.get("tracks") or []
    loudness_ok = annotate_tracks(tracks)
    artwork.annotate(tracks)
    if state is not None and loudness_ok is True:
        try:
            if library_incremental.annotations_current(artwork, state):
                revision = library_incremental.revision_for(user_id, state)
                if wants_delta and tracks:
                    try:
                        digests = library_incremental.header_digests({k: v for k, v in payload.items() if k != "tracks"})
                        library_incremental.remember(user_id, revision, state, digests)
                    except Exception:
                        logger.debug("Incremental base unavailable; sending full snapshot", exc_info=True)
                return _library_response(jsonify(payload), revision)
        except Exception:
            logger.debug("Annotation state changed; using content validation", exc_info=True)

    return _finalize_content_library_response(
        payload, user_id, artwork, base, wants_delta, dependencies, snapshot_fingerprint, loudness_ok
    )


@library_bp.route("/api/library/youtube-ids", methods=["GET"])
def get_library_youtube_ids():
    api = _get_api()
    lib = api["get_library"]()
    lib.refresh_if_stale()
    if not lib.metadata:
        lib.sync_library()
    if not lib.metadata:
        return jsonify({"youtube_ids": [], "youtube_to_track_id": {}})
    youtube_ids = []
    youtube_to_track_id = {}
    for t in lib.metadata.tracks:
        yt_id = getattr(t, "youtube_id", None)
        if yt_id and isinstance(yt_id, str) and len(yt_id) == 11:
            youtube_ids.append(yt_id)
            youtube_to_track_id[yt_id] = t.id
    return jsonify({"youtube_ids": youtube_ids, "youtube_to_track_id": youtube_to_track_id})


@library_bp.route("/api/library/sync", methods=["POST"])
@require_scope(SCOPE_LIBRARY_WRITE, allow_trusted_network=True)
@rate_limit("library_sync", limit=20, window_sec=60)
def sync_library():
    api = _get_api()
    lib = api["get_library"]()
    success = lib.sync_library()
    if success:
        api["emit_to_user"]("library_updated")
    return jsonify({"status": "success" if success else "failed"})


@library_bp.route("/api/library/scan", methods=["GET"])
@require_scope(SCOPE_LIBRARY_WRITE, allow_trusted_network=True)
@rate_limit("library_scan_status", limit=120, window_sec=60)
def library_scan_status():
    from shared.api.library_scan import library_scan_service

    return jsonify(library_scan_service.status(require_user_id()))


@library_bp.route("/api/library/scan", methods=["POST"])
@require_scope(SCOPE_LIBRARY_WRITE, allow_trusted_network=True)
@rate_limit("library_scan_start", limit=20, window_sec=60)
def start_library_scan():
    from shared.api.library_scan import library_scan_service

    api = _get_api()
    library = api["get_library"]()
    data = request.get_json(silent=True) or {}
    if not isinstance(data, dict):
        return jsonify({"error": "request body must be an object", "code": "invalid_scan_path"}), 400
    requested_path = data.get("path")
    if requested_path is not None and not isinstance(requested_path, str):
        return jsonify({"error": "path must be a string", "code": "invalid_scan_path"}), 400
    try:
        roots = library_scan_service.resolve_roots(library, requested_path)
    except ValueError as exc:
        return jsonify({"error": str(exc), "code": "invalid_scan_path"}), 400
    return jsonify(library_scan_service.start(require_user_id(), roots)), 202


@library_bp.route("/api/library/tracks/<track_id>", methods=["DELETE"])
@require_scope(SCOPE_LIBRARY_WRITE, allow_trusted_network=True)
@rate_limit("library_delete_track", limit=30, window_sec=60)
def delete_track_from_library(track_id):
    api = _get_api()
    lib = api["get_library"]()
    track = api["get_track_by_id"](lib, track_id)
    if not track:
        return jsonify({"error": "Track not found"}), 404
    logger.info("API: Deleting track %s (%s)...", track.title, track_id)
    success = lib.delete_track(track)
    if success:
        # The download pool's catalog is shared. A personal removal must not remove
        # an object still owned by another account; cleanup reconciles it later.
        api["emit_to_user"]("library_updated")
        return jsonify({"status": "success"})
    from shared.library_lifecycle import LibraryPersistenceError
    raise LibraryPersistenceError(getattr(lib, "last_save_error", None))


@library_bp.route("/api/library/wipe", methods=["POST"])
@require_scope(SCOPE_ADMIN_DANGEROUS, allow_trusted_network=True)
@rate_limit("library_wipe", limit=3, window_sec=300)
def wipe_library():
    api = _get_api()
    data = request.get_json(silent=True) or {}
    if data.get("confirm") not in ("CONFIRM", "confirm"):
        return jsonify({"error": "Body must include confirm: 'CONFIRM' or 'confirm'"}), 400
    try:
        lib = api["get_library"]()
        success = lib.nuke_library()
        if not success:
            return jsonify({"error": "Wipe failed"}), 500
        api["emit_to_user"]("library_updated")
        return jsonify({"status": "success"})
    except Exception as e:
        logger.exception("API: Library wipe error: %s", e)
        return jsonify({"error": "Wipe failed"}), 500


@library_bp.route("/api/library/search", methods=["GET"])
def search_library():
    api = _get_api()
    lib = api["get_library"]()
    query = request.args.get("q", "").lower()
    results = lib.search(query)
    tracks = [t.to_dict() for t in results[:50]]
    annotate_tracks(tracks)
    return jsonify(tracks)


@library_bp.route("/api/library/purge-missing", methods=["POST"])
@require_scope(SCOPE_LIBRARY_WRITE, allow_trusted_network=True)
@rate_limit("library_purge_missing", limit=10, window_sec=300)
def purge_missing_library_tracks():
    """
    Remove library entries for tracks whose audio files no longer exist locally
    (and, if a cloud provider is configured, have no corresponding remote object).
    Restricted to trusted networks (Home/Tailscale).
    """
    api = _get_api()
    lib = api["get_library"]()
    lib.refresh_if_stale()
    if not lib.metadata:
        lib.sync_library()
    if not lib.metadata:
        return jsonify({"error": "Library not loaded"}), 404

    summary = lib.purge_missing_tracks()
    api["emit_to_user"]("library_updated")
    return jsonify({"status": "success", **summary})


def _kick_enrichment(db, cache_key, artist, title, album, duration, record, *, persist=True):
    """Start or poll Phase 2 word/syllable enrichment without blocking playback.

    Returns ``(updated_record, is_enriching)``. When persisted, completion
    settles the DB row itself so a client that never comes back still benefits
    on the next play.
    """
    from shared.lyrics import poll_enrichment, record_text, settle_enrichment, worth_enriching

    if not worth_enriching(record):
        return record, False
    ref_text = record_text(record)
    if persist and cache_key:
        def on_done(found):
            settle_enrichment(db, cache_key, found)

        def needed():
            return worth_enriching(db.get_lyrics(cache_key))

        status, found = poll_enrichment(
            artist,
            title,
            album,
            duration,
            reference_text=ref_text,
            existing_source=record.get("source"),
            on_complete=on_done,
            needed=needed,
        )
        if status == "settled":
            return db.get_lyrics(cache_key) or record, False
        if status == "complete" and found is not None:
            settle_enrichment(db, cache_key, found)
            return db.get_lyrics(cache_key) or {**record, **found}, False
        return record, status == "pending"

    status, found = poll_enrichment(
        artist,
        title,
        album,
        duration,
        reference_text=ref_text,
        existing_source=record.get("source"),
    )
    if status == "complete" and found is not None:
        return {**record, **found}, False
    return record, status == "pending"


@library_bp.route("/api/library/tracks/<track_id>/lyrics", methods=["GET"])
@rate_limit("library_lyrics", limit=60, window_sec=60)
def get_track_lyrics(track_id):
    """Lyrics for a library track: served from the local cache when present,
    otherwise fetched (LRCLIB, then lrc.red, then NetEase) and cached, with
    non-blocking Phase 2 syllable/word enrichment."""
    from shared.database import instance_db
    from shared.lyrics import audio_key, poll_lyrics, settle_upgrade, store, worth_looking_up_again

    api = _get_api()
    lib = api["get_library"]()
    track = api["get_track_by_id"](lib, track_id)
    if not track:
        return jsonify({"error": "Track not found"}), 404

    db = instance_db()
    offset_ms = db.get_lyrics_offset(audio_key(getattr(track, "youtube_id", None), track.id))

    def payload(record, cached=False, enriching=False):
        return jsonify(_lyrics_payload(
            record, cached=cached, audio_duration=track.duration, offset_ms=offset_ms, enriching=enriching,
        ))

    def serve_with_enrichment(record, cached=False):
        updated, enriching = _kick_enrichment(
            db, track_id, track.artist, track.title, track.album, track.duration, record, persist=True,
        )
        return payload(updated, cached=cached, enriching=enriching)

    refresh = request.args.get("refresh") in ("1", "true")
    cached = None if refresh else db.get_lyrics(track_id)
    if cached and not worth_looking_up_again(cached, track.duration):
        return serve_with_enrichment(cached, cached=True)

    # Lyrics an older resolver left without timing that fits are looked up
    # once more. They are served while that runs, and whenever the provider
    # cannot answer; the player therefore does not come back for the answer,
    # so the lookup settles the row itself when it lands.
    settle = needed = None
    if cached:
        def settle(found, held=cached):
            if found is not None:
                settle_upgrade(db, track_id, held, found)

        # The lookup may have settled the row and been forgotten since it was
        # read above; then there is nothing left to look up.
        def needed():
            return worth_looking_up_again(db.get_lyrics(track_id), track.duration)
    lookup_status, record = poll_lyrics(
        track.artist, track.title, track.album, track.duration, on_complete=settle, needed=needed,
    )
    if lookup_status == "settled":
        return serve_with_enrichment(db.get_lyrics(track_id) or cached, cached=True)
    if lookup_status != "complete":
        if cached:
            return payload(cached, cached=True)
        return jsonify(_lyrics_payload(status="pending")), 202
    if record is None:
        if cached:
            return payload(cached, cached=True)
        # Provider unreachable: don't cache, let a later request retry.
        return jsonify(_lyrics_payload(status="unavailable"))
    if cached:
        served = settle_upgrade(db, track_id, cached, record)
        return serve_with_enrichment(served, cached=served is not record)
    store(db, track_id, record)
    return serve_with_enrichment(record, cached=False)


@library_bp.route("/api/lyrics", methods=["GET"])
@rate_limit("lyrics_lookup", limit=60, window_sec=60)
def get_lyrics_by_metadata():
    """Lyrics lookup by metadata, for tracks not in the library (previews).
    Saved previews may opt into a persistent cache keyed by their normalized
    metadata; cold provider work runs through the bounded coordinator."""
    from shared.database import instance_db
    from shared.lyrics import audio_key, metadata_cache_key, poll_lyrics, store
    from shared.music_identity import synced_lyrics_safe

    artist = (request.args.get("artist") or "").strip()
    title = (request.args.get("title") or "").strip()
    album = (request.args.get("album") or "").strip() or None
    source_kind = (request.args.get("source_kind") or "").strip() or None
    youtube_id = (request.args.get("youtube_id") or "").strip() or None
    try:
        duration = int(request.args.get("duration") or 0) or None
    except ValueError:
        duration = None
    if not artist or not title:
        return jsonify({"error": "artist and title are required"}), 400

    persist = request.args.get("persist") in ("1", "true")
    refresh = request.args.get("refresh") in ("1", "true")
    db = instance_db()
    offset_ms = db.get_lyrics_offset(audio_key(youtube_id))
    vouched = source_kind is None or synced_lyrics_safe(str(source_kind))

    def payload(record, cached=False, enriching=False):
        return jsonify(_lyrics_payload(
            record,
            cached=cached,
            source_kind=source_kind,
            audio_duration=duration,
            offset_ms=offset_ms,
            enriching=enriching,
        ))

    cache_key = metadata_cache_key(artist, title, album, duration)

    def serve_with_enrichment(record, cached=False):
        if not vouched:
            return payload(record, cached=cached, enriching=False)
        updated, enriching = _kick_enrichment(
            db, cache_key if persist else None, artist, title, album, duration, record, persist=persist,
        )
        return payload(updated, cached=cached, enriching=enriching)

    if persist and not refresh:
        cached = db.get_lyrics(cache_key)
        if cached:
            return serve_with_enrichment(cached, cached=True)

    lookup_status, record = poll_lyrics(artist, title, album, duration)
    if lookup_status != "complete":
        return jsonify(_lyrics_payload(status="pending")), 202
    if record is None:
        return jsonify(_lyrics_payload(status="unavailable"))
    if persist:
        store(db, cache_key, record)
    return serve_with_enrichment(record, cached=False)


#: Further than any intro or coda a cut adds; anything beyond is a typo.
_MAX_LYRICS_OFFSET_MS = 10 * 60 * 1000


@library_bp.route("/api/lyrics/offset", methods=["PUT"])
@require_scope(SCOPE_LIBRARY_WRITE, allow_trusted_network=True)
@rate_limit("lyrics_offset", limit=60, window_sec=60)
def set_lyrics_offset():
    """Line a recording's lyrics up by hand: ``offset_ms`` later (or earlier,
    negative) than their timing says. ``null`` forgets the correction.

    Names the audio by ``track_id`` (a library track) or ``youtube_id`` (a
    stream). The offset belongs to that audio for everyone on this engine:
    it is a fact about the recording, not a preference.
    """
    from shared.database import instance_db
    from shared.lyrics import audio_key

    data = request.get_json(silent=True) or {}
    raw = data.get("offset_ms")
    if raw is None:
        offset_ms = None
    elif isinstance(raw, bool) or not isinstance(raw, (int, float)) or abs(raw) > _MAX_LYRICS_OFFSET_MS:
        return jsonify({"error": "offset_ms must be milliseconds within ten minutes, or null"}), 400
    else:
        offset_ms = int(round(raw))

    track_id = str(data.get("track_id") or "").strip()
    if track_id:
        api = _get_api()
        lib = api["get_library"]()
        track = api["get_track_by_id"](lib, track_id)
        if not track:
            return jsonify({"error": "Track not found"}), 404
        key = audio_key(getattr(track, "youtube_id", None), track.id)
    else:
        key = audio_key(str(data.get("youtube_id") or "").strip() or None)
    if not key:
        return jsonify({"error": "track_id or a valid youtube_id is required"}), 400

    instance_db().set_lyrics_offset(key, offset_ms)
    return jsonify({"offset_ms": offset_ms})


@library_bp.route("/api/library/track-labels/<track_id>/metadata", methods=["POST"])
@require_scope(SCOPE_LIBRARY_WRITE, allow_trusted_network=True)
@rate_limit("library_edit_labels", limit=60, window_sec=60)
@serialized
def update_track_labels(track_id):
    """Edit library labels while keeping audio, storage identity and references."""
    api = _get_api()
    lib = api["get_library"]()
    if not api["get_track_by_id"](lib, track_id):
        return jsonify({"error": "Track not found"}), 404
    data = request.get_json(silent=True)
    allowed = {"title", "artist", "album", "album_artist"}
    if not isinstance(data, dict) or not data or not set(data) <= allowed:
        return jsonify({"error": "Invalid metadata fields"}), 400
    if any(not (isinstance(value, str) and len(value) <= 4096)
           and not (key == "album_artist" and value is None)
           for key, value in data.items()):
        return jsonify({"error": "Invalid metadata value"}), 400
    if not api["mark_track_metadata_updated"](lib, track_id, changes=data):
        return jsonify({"error": "Track not found"}), 404
    return jsonify({"status": "success", "storage": "library", "id": track_id})


@library_bp.route("/api/library/track-labels/<track_id>/cover", methods=["POST"])
@require_scope(SCOPE_LIBRARY_WRITE, allow_trusted_network=True)
@rate_limit("library_edit_label_cover", limit=30, window_sec=60)
@serialized
def upload_track_label_cover(track_id):
    """Persist a validated sidecar; never download/rewrite/re-key the audio."""
    from shared.artwork import artwork_store, MAX_BYTES
    from PIL import Image, UnidentifiedImageError
    api = _get_api()
    lib = api["get_library"]()
    if not api["get_track_by_id"](lib, track_id):
        return jsonify({"error": "Track not found"}), 404
    file = request.files.get("file")
    if file is None or not file.filename:
        return jsonify({"error": "Image file required"}), 400
    store = artwork_store()
    data = file.stream.read(MAX_BYTES + 1)
    try:
        digest = store.put(data)
    except (ValueError, UnidentifiedImageError, OSError, Image.DecompressionBombError):
        return jsonify({"error": "Invalid artwork"}), 400
    # Commit account metadata first; a failed save never publishes the new cover.
    if not api["mark_track_metadata_updated"](lib, track_id, cover_source="manual"):
        return jsonify({"error": "Track not found"}), 404
    store.bind_override(track_id, digest, "manual")
    api["emit_to_user"]("library_updated", payload={"cover_changed": True})
    return jsonify({"status": "success", "storage": "library", "id": track_id})


@library_bp.route("/api/library/track-labels/<track_id>/cover/none", methods=["POST"])
@require_scope(SCOPE_LIBRARY_WRITE, allow_trusted_network=True)
@rate_limit("library_clear_label_cover", limit=30, window_sec=60)
@serialized
def clear_track_label_cover(track_id):
    api = _get_api()
    lib = api["get_library"]()
    if not api["get_track_by_id"](lib, track_id):
        return jsonify({"error": "Track not found"}), 404
    if not api["mark_track_metadata_updated"](lib, track_id, cover_source="none"):
        return jsonify({"error": "Track not found"}), 404
    return jsonify({"status": "success", "storage": "library", "id": track_id})


@library_bp.route("/api/library/favourites", methods=["GET"])
def get_favourites():
    """Favourite **library** track ids. Stable contract for agents and the car UI.

    Resolved against the library rather than read straight off the stored `lib:`
    keys, so a song favourited as a preview and downloaded later shows up here
    the moment it lands.
    """
    api = _get_api()
    api["get_library"]()
    return jsonify(api["favourite_library_ids"]())


@library_bp.route("/api/library/favourites/entries", methods=["GET"])
def get_favourite_entries():
    """The favourites list — identity keys plus the snapshot needed to render
    and stream a song that is not downloaded. Newest first."""
    api = _get_api()
    api["get_library"]()
    return jsonify(
        {"version": 2, "favourites": api["favourites_manager"].get_favourite_entries()}
    )


@library_bp.route("/api/library/saved", methods=["GET"])
def get_saved_entries():
    """Every song in this account's library that is not (or not only) a file:
    identity keys, snapshot, and whether it is marked a favourite. Newest first.

    Compatibility facade over canonical collection properties. New clients use
    /api/library/collection for items, sources and playlists in one snapshot.
    """
    api = _get_api()
    api["get_library"]()
    return jsonify({"version": 3, "saved": api["favourites_manager"].get_entries()})


@library_bp.route("/api/library/collection", methods=["GET"])
def get_collection():
    """One account snapshot: musical items, sources, marks and memberships."""
    api = _get_api()
    lib = api["get_library"]()
    lib.refresh_if_stale()
    from shared.collection import Collection
    from shared.artwork import artwork_store
    from shared.user_context import require_user_id
    collection = Collection(lib.db)
    dependencies = _annotation_revisions(artwork_store())
    revisions = collection.revisions()
    token = sha256(repr((require_user_id(), revisions, dependencies)).encode()).hexdigest()
    if request.if_none_match.contains_weak(token):
        response = jsonify(None)
        response.status_code = 304
        response.set_etag(token, weak=True)
        response.headers['Cache-Control'] = 'private, no-cache'
        response.vary.update(('Cookie', 'X-Soundsible-Admin-Token'))
        return response
    payload = _collection_payload(lib)
    response = jsonify(payload)
    if revisions != (payload['revision'], payload['library_revision']) or dependencies != _annotation_revisions(artwork_store()):
        token = sha256(response.get_data()).hexdigest()
    response.set_etag(token, weak=True)
    response.headers['Cache-Control'] = 'private, no-cache'
    response.vary.update(('Cookie', 'X-Soundsible-Admin-Token'))
    return response


def _collection_payload(lib):
    from shared.collection import Collection
    payload = Collection(lib.db).snapshot()
    rows = [*payload['files'], *(row for row in payload['items'] if row.get('source') == 'preview')]
    annotate_tracks(rows)
    from shared.artwork import artwork_store
    artwork_store().annotate(rows)
    return payload


@library_bp.route("/api/library/saved/toggle", methods=["POST"])
@require_scope(SCOPE_LIBRARY_WRITE, allow_trusted_network=True)
@rate_limit("library_toggle_saved", limit=120, window_sec=60)
def toggle_saved():
    """Add or remove a song from the library by identity (`entry`), no file involved."""
    api = _get_api()
    api["get_library"]()
    data = request.json or {}
    entry = data.get("entry") or data.get("saved")
    if not isinstance(entry, dict):
        return jsonify({"error": "entry must be an object"}), 400

    try:
        is_saved = api["favourites_manager"].toggle_saved(entry)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    if is_saved:
        _schedule_favourite_resolve(entry)

    api["emit_to_user"]("favourites_updated")
    return jsonify({"status": "success", "is_saved": is_saved})


#: Longer than any record; an artist's catalogue arrives in several of these.
_MAX_SAVED_BATCH = 500


@library_bp.route("/api/library/saved/set", methods=["POST"])
@require_scope(SCOPE_LIBRARY_WRITE, allow_trusted_network=True)
@rate_limit("library_set_saved", limit=30, window_sec=60)
def set_saved():
    """Save many songs, or take them out, by identity — an album in one act.

    Never flips a song: see `FavouritesManager.set_saved` for what removing
    leaves alone.
    """
    api = _get_api()
    api["get_library"]()
    data = request.json or {}
    entries = data.get("entries")
    saved = data.get("saved")
    if not isinstance(entries, list) or not isinstance(saved, bool):
        return jsonify({"error": "entries must be an array and saved a boolean"}), 400
    if len(entries) > _MAX_SAVED_BATCH:
        return jsonify({"error": f"at most {_MAX_SAVED_BATCH} entries at once"}), 400

    enriched: list = []
    changed = api["favourites_manager"].set_saved(entries, saved, enriched)
    if saved:
        for entry in changed:
            _schedule_favourite_resolve(entry)
    if changed or enriched:
        api["emit_to_user"]("favourites_updated")
    return jsonify({"status": "success", "changed": len(changed)})


@library_bp.route("/api/library/favourites", methods=["PUT"])
@require_scope(SCOPE_LIBRARY_WRITE, allow_trusted_network=True)
@rate_limit("library_set_favourite", limit=120, window_sec=60)
def set_favourite():
    """Set a captured intention without toggling another client's updated mark."""
    data = request.get_json(silent=True) or {}
    if not isinstance(data, dict):
        return jsonify(error="object body required"), 400
    entry, marked = data.get("entry"), data.get("marked")
    if not isinstance(entry, dict) or not isinstance(marked, bool):
        return jsonify(error="entry and boolean marked are required"), 400
    api = _get_api()
    api["get_library"]()
    try:
        result = api["favourites_manager"].set_favourite(entry, favourite=marked, save_if_missing=False)
    except ValueError as exc:
        return jsonify(error=str(exc)), 400
    if result and not any(isinstance(key, str) and key.startswith("lib:") for key in entry.get("keys", [])):
        _schedule_favourite_resolve(entry)
    api["emit_to_user"]("favourites_updated")
    return jsonify(is_favourite=result)


@library_bp.route("/api/library/favourites/toggle", methods=["POST"])
@require_scope(SCOPE_LIBRARY_WRITE, allow_trusted_network=True)
@rate_limit("library_toggle_favourite", limit=120, window_sec=60)
def toggle_favourite():
    """Toggle the favourite mark, by identity (`favourite`) or library id (`track_id`).

    Marking a song the library does not hold saves it in the same act — you
    cannot single out a song you do not have. Unmarking leaves it saved.
    """
    api = _get_api()
    api["get_library"]()
    data = request.json or {}
    favourite = data.get("favourite")
    manager = api["favourites_manager"]

    if isinstance(favourite, dict):
        try:
            is_fav = manager.set_favourite(favourite)
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400
        if is_fav:
            _schedule_favourite_resolve(favourite)
    else:
        track_id = data.get("track_id")
        if not track_id:
            return jsonify({"error": "No track_id provided"}), 400
        try:
            is_fav = manager.toggle(track_id)
        except ValueError:
            return jsonify({"error": "Track not found"}), 404

    # Other devices on this account would otherwise not see the change until a
    # full library sync — every other mutating route here already emits.
    api["emit_to_user"]("favourites_updated")
    try:
        from shared.discovery_signals import notify_discovery_signal

        notify_discovery_signal(always_refresh=bool(is_fav))
    except Exception:
        logger.debug("Discovery feed notify failed after favourite toggle", exc_info=True)
    return jsonify({"status": "success", "is_favourite": is_fav, "is_fav": is_fav})


def _schedule_favourite_resolve(favourite: dict) -> None:
    """
    Give a favourite a playable identity in the background.

    A Deezer/MusicBrainz row saved without ever being played carries no `yt:`
    key, so nothing can stream it. Resolving it here — off the request, through
    the same permanently-cached resolver the catalog uses — means the heart stays
    instant while the song quietly becomes playable a moment later.
    """
    keys = [k for k in (favourite.get("keys") or []) if isinstance(k, str)]
    if not keys or any(k.startswith("yt:") for k in keys):
        return
    artist = (favourite.get("artist") or "").strip()
    title = (favourite.get("title") or "").strip()
    if not artist or not title:
        return

    from shared.user_context import current_user_id

    user_id = current_user_id()
    duration = favourite.get("duration")
    duration_s = int(duration) if isinstance(duration, (int, float)) and duration > 0 else None

    get_downloader = _get_api()["get_downloader"]

    def _resolve():
        from shared.realtime import emit_to_user
        from shared.user_cores import get_favourites_manager
        from shared.user_context import user_context

        try:
            # The whole resolution runs as the account: a downloader built on
            # first use reads the bound account's library settings.
            with user_context(user_id):
                best, _ = catalog_resolution.resolve_candidates(get_downloader, artist, title, duration_s)
                video_id = (best or {}).get("id")
                if not video_id:
                    return
                manager = get_favourites_manager(user_id)
                if manager.update_keys(keys, [f"yt:{video_id}"]):
                    emit_to_user("favourites_updated", user_id=user_id)
        except Exception as exc:  # pragma: no cover — best-effort enrichment
            logger.debug("Favourite resolve failed for %s — %s: %s", artist, title, exc)

    try:
        from shared.orchestrator import orchestrator

        orchestrator.submit_background(f"fav_resolve_{keys[0]}", _resolve)
    except Exception as exc:  # pragma: no cover — never block the toggle
        logger.debug("Could not queue favourite resolve: %s", exc)


@library_bp.route("/api/library/playlists", methods=["POST"])
@require_scope(SCOPE_LIBRARY_WRITE, allow_trusted_network=True)
@rate_limit("playlist_create", limit=60, window_sec=60)
@serialized
def create_playlist():
    api = _get_api()
    lib, metadata = api["ensure_library_metadata"]()
    if not metadata:
        return jsonify({"error": "Library not loaded"}), 404
    data = request.json or {}
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"error": "name is required"}), 400
    if name in metadata.playlists:
        return jsonify({"error": "Playlist already exists"}), 409
    metadata = metadata.copy_for_playlist_edit()
    metadata.create_playlist(name)
    return _commit_playlists(api, lib, metadata)


@library_bp.route("/api/library/playlist-edits", methods=["PATCH"])
@library_bp.route("/api/library/playlists", methods=["PATCH"])
@require_scope(SCOPE_LIBRARY_WRITE, allow_trusted_network=True)
@rate_limit("playlist_reorder", limit=60, window_sec=60)
@serialized
def reorder_playlists():
    api = _get_api()
    lib, metadata = api["ensure_library_metadata"]()
    if not metadata:
        return jsonify({"error": "Library not loaded"}), 404
    data = request.json or {}
    if not isinstance(data, dict):
        return jsonify(error="object body required"), 400
    if request.path.startswith("/api/library/playlist-edits") and "expected_order" not in data:
        return jsonify(error="expected_order required"), 400
    order = data.get("order")
    if not isinstance(order, list):
        return jsonify({"error": "order must be a list of playlist names"}), 400
    if "expected_order" in data:
        if not isinstance(data["expected_order"], list) or not all(isinstance(name, str) for name in data["expected_order"]):
            return jsonify(error="expected_order must be a string list"), 400
        if data["expected_order"] != metadata.ordered_playlist_names():
            return jsonify(error="Playlist order changed; refresh before editing"), 409
        if not all(isinstance(name, str) for name in order) or len(order) != len(set(order)) or set(order) != set(metadata.playlists):
            return jsonify(error="order must contain every playlist once"), 400
    metadata = metadata.copy_for_playlist_edit()
    metadata.reorder_playlists(order)
    return _commit_playlists(api, lib, metadata)


@library_bp.route("/api/library/playlists/<path:name>/tracks", methods=["POST"])
@require_scope(SCOPE_LIBRARY_WRITE, allow_trusted_network=True)
@rate_limit("playlist_add_track", limit=120, window_sec=60)
@serialized
def add_track_to_playlist(name):
    name = unquote(name)
    api = _get_api()
    lib, metadata = api["ensure_library_metadata"]()
    if not metadata:
        return jsonify({"error": "Library not loaded"}), 404
    if name not in metadata.playlists:
        return jsonify({"error": "Playlist not found"}), 404
    data = request.json or {}
    if not isinstance(data, dict):
        return jsonify(error="object body required"), 400
    if "entry" in data:
        from shared.collection_entries import _normalise_entry
        raw = data['entry']
        entry = _normalise_entry(raw, default_favourite=False) if isinstance(raw, dict) else None
        if entry is None:
            return jsonify(error="entry needs an identity"), 400
        if not lib._save_metadata(metadata=metadata.copy_for_playlist_edit(), playlist_entry=(name, entry)):
            from shared.library_lifecycle import LibraryPersistenceError
            raise LibraryPersistenceError(lib.last_save_error)
        api["emit_to_user"]("library_updated")
        api["emit_to_user"]("favourites_updated")
        return jsonify(status="success", item_id=entry['item_id'], **_collection_payload(lib))
    track_id = data.get("track_id")
    if not isinstance(track_id, str) or not track_id:
        return jsonify({"error": "track_id is required"}), 400
    from shared.collection import Collection
    track_id = Collection(lib.db).identify([f'item:{track_id}', f'lib:{track_id}', f'yt:{track_id}']) or track_id
    metadata = metadata.copy_for_playlist_edit()
    if not metadata.add_to_playlist(name, track_id):
        return jsonify({"error": "Add to playlist failed"}), 500
    return _commit_playlists(api, lib, metadata)


@library_bp.route("/api/library/playlists/<path:name>/tracks/<track_id>", methods=["DELETE"])
@require_scope(SCOPE_LIBRARY_WRITE, allow_trusted_network=True)
@rate_limit("playlist_remove_track", limit=120, window_sec=60)
@serialized
def remove_track_from_playlist(name, track_id):
    name = unquote(name)
    api = _get_api()
    lib, metadata = api["ensure_library_metadata"]()
    if not metadata:
        return jsonify({"error": "Library not loaded"}), 404
    if name not in metadata.playlists:
        return jsonify({"error": "Playlist not found"}), 404
    metadata = metadata.copy_for_playlist_edit()
    if not metadata.remove_from_playlist(name, track_id):
        return jsonify({"error": "Remove from playlist failed"}), 500
    return _commit_playlists(api, lib, metadata)


@library_bp.route("/api/library/playlist-edits/<path:name>", methods=["PATCH"])
@library_bp.route("/api/library/playlists/<path:name>", methods=["PATCH"])
@require_scope(SCOPE_LIBRARY_WRITE, allow_trusted_network=True)
@rate_limit("playlist_update", limit=80, window_sec=60)
@serialized
def update_playlist(name):
    name = unquote(name)
    api = _get_api()
    lib, metadata = api["ensure_library_metadata"]()
    if not metadata:
        return jsonify({"error": "Library not loaded"}), 404
    if name not in metadata.playlists:
        return jsonify({"error": "Playlist not found"}), 404
    data = request.json or {}
    if not isinstance(data, dict):
        return jsonify(error="object body required"), 400
    if request.path.startswith("/api/library/playlist-edits") and "expected_track_ids" not in data:
        return jsonify(error="expected_track_ids required"), 400
    conflict = _playlist_precondition(metadata, name, data)
    if conflict is not None:
        return conflict
    # Validate the entire edit before mutating the shared in-memory metadata.
    proposed_ids = data.get("track_ids", metadata.playlists[name])
    if not isinstance(proposed_ids, list) or not all(isinstance(value, str) for value in proposed_ids):
        return jsonify(error="track_ids must be a string list"), 400
    new_name = None
    if "name" in data:
        value = data["name"]
        if not isinstance(value, str) or not (new_name := value.strip()):
            return jsonify(error="name cannot be empty"), 400

    cover_tid = None
    if "cover_track_id" in data:
        cover = data["cover_track_id"]
        if cover is not None and not isinstance(cover, str):
            return jsonify(error="Invalid cover_track_id (not in playlist)"), 400
        cover_tid = (cover or "").strip() or None
        if cover_tid is not None and cover_tid not in proposed_ids:
            return jsonify(error="Invalid cover_track_id (not in playlist)"), 400

    metadata = metadata.copy_for_playlist_edit()
    if new_name is not None:
        if not metadata.rename_playlist(name, new_name):
            return jsonify({"error": "Rename failed (new name may already exist)"}), 409
        name = new_name
    if "track_ids" in data:
        metadata.set_playlist_tracks(name, proposed_ids)
    if "cover_track_id" in data:
        if not metadata.set_playlist_cover_track_id(name, cover_tid):
            return jsonify(error="Invalid cover_track_id (not in playlist)"), 400
    return _commit_playlists(api, lib, metadata)


@library_bp.route("/api/library/playlist-edits/<path:name>", methods=["DELETE"])
@library_bp.route("/api/library/playlists/<path:name>", methods=["DELETE"])
@require_scope(SCOPE_LIBRARY_WRITE, allow_trusted_network=True)
@rate_limit("playlist_delete", limit=60, window_sec=60)
@serialized
def delete_playlist(name):
    name = unquote(name)
    api = _get_api()
    lib, metadata = api["ensure_library_metadata"]()
    if not metadata:
        return jsonify({"error": "Library not loaded"}), 404
    data = request.get_json(silent=True) or {}
    if not isinstance(data, dict):
        return jsonify(error="object body required"), 400
    if request.path.startswith("/api/library/playlist-edits") and "expected_track_ids" not in data:
        return jsonify(error="expected_track_ids required"), 400
    conflict = _playlist_precondition(metadata, name, data)
    if conflict is not None:
        return conflict
    metadata = metadata.copy_for_playlist_edit()
    if not metadata.delete_playlist(name):
        return jsonify({"error": "Playlist not found"}), 404
    return _commit_playlists(api, lib, metadata)


@library_bp.route("/api/library/repair", methods=["POST"])
@require_scope(SCOPE_LIBRARY_WRITE, allow_trusted_network=True)
@rate_limit("library_repair", limit=6, window_sec=300)
def repair_library_files():
    """Drop video streams and cap artwork on the files this library holds.

    `dry_run` defaults to true: the pass rewrites files and re-keys track ids,
    and both of those are worth reading a report about first. Progress goes to
    the downloader log, which is where the other maintenance passes report.
    """
    from shared.library_tasks import run_library_repair_task

    data = request.json or {}
    dry_run = data.get("dry_run", True)
    try:
        limit = max(0, int(data.get("limit") or 0))
    except (TypeError, ValueError):
        limit = 0
    run_library_repair_task(bool(dry_run), limit)
    return jsonify({"status": "started", "dry_run": bool(dry_run), "limit": limit})


@library_bp.route('/api/library/saved-entities', methods=['GET'])
def get_saved_entities():
    from player.saved_entities import get_entries
    return jsonify({'entities': get_entries()})


@library_bp.route('/api/library/saved-entities', methods=['PUT'])
@require_scope(SCOPE_LIBRARY_WRITE, allow_trusted_network=True)
@rate_limit('library_saved_entities', limit=120, window_sec=60)
def update_saved_entity():
    from player.saved_entities import set_saved
    from shared.realtime import emit_to_user
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({'error': 'Expected an object'}), 400
    try:
        entries = set_saved(data.get('entry'), data.get('saved'))
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400
    emit_to_user('saved_entities_updated')
    return jsonify({'entities': entries})
