from __future__ import annotations

import logging
import re
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from typing import Any

from flask import Blueprint, jsonify, request

try:
    import gevent  # noqa: F401  # imported to probe availability
    from gevent import spawn, joinall
    _HAS_GEVENT = True
except ImportError:  # pragma: no cover
    _HAS_GEVENT = False

from shared import catalog_resolution, deezer_catalog, request_scope
from shared.deezer_catalog import (
    duration_seconds,
    extract_year,
    positive_int,
)
from shared.memo import Memo
from shared.database import instance_db
from shared.discovery_graph_store import load_artist_discography
from shared.musicbrainz import normalize_recording_mbid
from shared.providers import deezer
from shared.hardening import SCOPE_LIBRARY_WRITE, rate_limit, require_scope
from shared.resolution_confidence import classify_confidence
from shared.text_utils import (
    fold_text,
    sanitize_cli_message,
)
from shared import catalog_search as catalog_service


logger = logging.getLogger(__name__)

catalog_bp = Blueprint("catalog", __name__, url_prefix="")


@catalog_bp.after_request
def collection_references(response):
    from shared.user_context import current_user_id
    if response.status_code == 200 and response.is_json and current_user_id() and (
        request.method == 'GET' or request.path == '/api/catalog/resolve'
    ):
        from shared.collection import Collection
        # Decode the response, not a shallow copy of a cached provider body.
        # Account references must never be retained in a provider's cache.
        body = Collection().annotate_catalog(response.get_json())
        response.set_data(jsonify(body).get_data())
        response.headers['Cache-Control'] = 'private, no-cache'
        response.vary.update(('Cookie', 'X-Soundsible-Admin-Token'))
    return response


@catalog_bp.route("/api/catalog/search", methods=["GET"])
@rate_limit("catalog_search", limit=120, window_sec=60)
def catalog_search():
    query = catalog_service.clean(request.args.get("q", ""))
    if len(query) < 2:
        return jsonify({"query": query, "items": [], "sections": [], "partial_failures": [], "cached": False})
    limit = min(50, max(1, request.args.get("limit", type=int) or 30))
    types = {x.strip() for x in (request.args.get("type") or "all").split(",") if x.strip()}
    body, cached = catalog_service.cached_search(query, types, limit)
    body["cached"] = cached
    return jsonify(body)


@catalog_bp.route("/api/catalog/resolve", methods=["POST"])
@rate_limit("catalog_resolve", limit=80, window_sec=60)
def catalog_resolve():
    data = request.get_json(silent=True) or {}
    artist = catalog_service.clean(data.get("artist"))
    title = catalog_service.clean(data.get("title"))
    duration_s = duration_seconds(data.get("duration"))
    if not artist or not title:
        return jsonify({"error": "artist and title are required"}), 400
    try:
        best, candidates = catalog_resolution.resolve_candidates(catalog_service.engine_api()["get_downloader"], artist, title, duration_s)
    except Exception as exc:
        logger.warning("Catalog resolve failed: %s", exc)
        return jsonify({"status": "failed", "reason": "search_error", "candidates": []}), 502
    if not best:
        return jsonify({"status": "failed", "reason": "not_found", "candidates": []}), 404
    score = float(best.get("confidence") or 0)
    return jsonify({
        "status": "resolved",
        "video_id": best.get("id"),
        "confidence": score,
        "confidence_level": classify_confidence(score),
        "confidence_reason": best.get("confidence_reason"),
        "best": best,
        "candidates": candidates,
    })


def _album_evidence(data: dict[str, Any]) -> dict[str, Any]:
    """The record a song is saved from, when the request names one.

    Without it the download files the song under whatever release YouTube tags
    it with, as its track 1, and an album saved song by song comes apart in the
    library. Nothing here is guessed: absent fields stay absent.
    """
    def text(value: object) -> str:
        return catalog_service.clean(value, 200) if isinstance(value, str) else ""

    album = text(data.get("album"))
    if not album:
        return {}
    evidence: dict[str, Any] = {"album": album}
    album_artist = text(data.get("album_artist"))
    if album_artist:
        evidence["album_artist"] = album_artist
    for key, upper in (("track_number", 999), ("disc_number", 99)):
        value = positive_int(data.get(key), upper)
        if value:
            evidence[key] = value
    year = positive_int(data.get("year"), 9999)
    if year and year >= 1000:
        evidence["year"] = year
    return evidence


@catalog_bp.route("/api/catalog/save", methods=["POST"])
@rate_limit("catalog_save", limit=60, window_sec=60)
def catalog_save():
    data = request.get_json(silent=True) or {}
    artist = catalog_service.clean(data.get("artist"))
    title = catalog_service.clean(data.get("title"))
    if not artist or not title:
        return jsonify({"error": "artist and title are required"}), 400
    duration_s = duration_seconds(data.get("duration"))
    confirm_video_id = catalog_service.clean(data.get("confirm_video_id"), 32) or None
    video_id = confirm_video_id
    candidates: list[dict[str, Any]] = []
    confidence = 1.0
    confidence_reason = "confirmed"

    if not video_id:
        try:
            best, candidates = catalog_resolution.resolve_candidates(catalog_service.engine_api()["get_downloader"], artist, title, duration_s)
        except Exception as exc:
            logger.warning("Catalog save resolve failed: %s", exc)
            return jsonify({"status": "failed", "reason": "search_error", "candidates": []}), 502
        if not best:
            return jsonify({"status": "failed", "reason": "not_found", "candidates": []}), 404
        confidence = float(best.get("confidence") or 0)
        confidence_reason = best.get("confidence_reason") or ""
        if classify_confidence(confidence) != "high":
            return jsonify({
                "status": "needs_review",
                "confidence": confidence,
                "confidence_level": classify_confidence(confidence),
                "confidence_reason": confidence_reason,
                "best": best,
                "candidates": candidates,
            })
        video_id = best.get("id")

    external_ids = dict(data.get("external_ids")) if isinstance(data.get("external_ids"), dict) else {}
    musicbrainz_id = normalize_recording_mbid(external_ids.get("musicbrainz_id"))
    external_ids.pop("musicbrainz_id", None)
    if musicbrainz_id:
        external_ids["musicbrainz_id"] = musicbrainz_id

    api = catalog_service.engine_api()
    metadata_evidence = {
        "title": title,
        "artist": artist,
        "catalog_item_id": data.get("catalog_item_id"),
        "source": data.get("source"),
        "external_ids": external_ids,
    }
    if musicbrainz_id:
        # Flatten the identity at the acquisition boundary so every downstream
        # path can consume the same trusted scalar without understanding a
        # catalog response's nested shape.
        metadata_evidence["musicbrainz_id"] = musicbrainz_id
    metadata_evidence.update(_album_evidence(data))
    # The client URL and claimed provider are not fetch authority. Revalidate
    # the actual provider record and bind its image to this account/video.
    if re.fullmatch(r'deezer:track:[0-9]+', str(data.get('catalog_item_id') or '')) and data.get('album'):
        try:
            record = deezer_catalog.deezer_get('track/' + data['catalog_item_id'].rsplit(':', 1)[-1])
            album = record.get('album') or {}
            if (fold_text(record.get('title') or '') == fold_text(title)
                    and fold_text((record.get('artist') or {}).get('name') or '') == fold_text(artist)
                    and fold_text(album.get('title') or '') == fold_text(data['album'])):
                from shared.artwork_sources import selection
                receipt = selection(video_id, data['catalog_item_id'], deezer.image(album, 'cover'))
                if receipt:
                    metadata_evidence['artwork_selection'] = receipt
        except Exception:
            logger.debug('Catalog artwork verification unavailable; retaining source image', exc_info=True)
    item = {
        "source_type": "ytmusic_search",
        "video_id": video_id,
        "display_title": title,
        "display_artist": artist,
        "thumbnail_url": data.get("cover") or f"https://img.youtube.com/vi/{video_id}/mqdefault.jpg",
        "duration_sec": duration_s,
        "metadata_evidence": metadata_evidence,
        # The row's identity, so a saved row downloaded from here lands as that
        # saved song (see `parse_intake_item`).
        "identity_keys": data.get("identity_keys"),
    }
    parsed, err = api["parse_intake_item"](item)
    if err:
        return jsonify({"status": "failed", "reason": err, "candidates": candidates}), 400
    import hashlib
    import json as _json

    parsed["intake_source"] = parsed.get("source_type")
    parsed["intake_payload_hash"] = hashlib.sha256(
        _json.dumps(parsed, sort_keys=True, default=str).encode("utf-8")
    ).hexdigest()
    new_item = api["queue_manager_dl"].add(parsed, user_id=api["user_id"])
    try:
        if not api["queue_manager_dl"].is_processing:
            api["start_downloader_pump"]()
    except Exception:
        pass
    return jsonify({
        "status": "queued",
        "queue_id": new_item.get("id"),
        "video_id": video_id,
        "confidence": confidence,
        "confidence_level": "confirmed" if confidence_reason == "confirmed" else classify_confidence(confidence),
        "confidence_reason": confidence_reason,
    })


# ──────────────────────────────────────────────────────────────────────────
# Artist & Album profile endpoints (native pages)
# ──────────────────────────────────────────────────────────────────────────








def _deezer_artist_profile(artist_id: str) -> dict[str, Any]:
    data = deezer_catalog.deezer_get(f"artist/{artist_id}")
    return {
        "name": (data.get("name") or "").strip(),
        "picture": deezer.image(data, "picture"),
        "nb_fans": int(data.get("nb_fan") or 0),
    }






_ISO_DATE_RE = re.compile(r"^[1-9]\d{3}-\d{2}-\d{2}$")


def _iso_release_date(value: Any) -> str:
    raw = str(value or "").strip()
    if not _ISO_DATE_RE.match(raw):
        return ""
    try:
        date.fromisoformat(raw)
    except ValueError:
        return ""
    return raw


def _release_sort_key(entry: dict[str, Any]) -> str:
    release_date = str(entry.get("release_date") or "").strip()
    if release_date:
        return release_date
    year = entry.get("year")
    if isinstance(year, int) and year > 0:
        return f"{year:04d}-00-00"
    return ""


def _deezer_artist_releases(artist_id: str, limit: int = 100) -> dict[str, list[dict[str, Any]]]:
    """Fetch an artist's releases once and split them into albums vs singles/EPs.

    Deezer accepts a `type` argument on this endpoint but ignores it — every
    value returns the same mixed rows — so passing "album" and "single,ep"
    fetched the identical list twice and rendered both rails identically.
    `record_type` on each row is what actually distinguishes them.
    """
    rows = load_artist_discography(artist_id, timeout=8.0)[:min(limit, 100)]
    albums: list[dict[str, Any]] = []
    singles_eps: list[dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        album_id = str(row.get("id") or "")
        title = catalog_service.clean(row.get("title"))
        if not album_id or not title:
            continue
        record_type = catalog_service.norm(row.get("record_type"))
        release_date = _iso_release_date(row.get("release_date"))
        entry = {
            "deezer_id": album_id,
            "title": title,
            "cover": deezer.image(row, "cover"),
            "year": extract_year(row.get("release_date")),
            "release_date": release_date,
            "record_type": record_type or "album",
        }
        # Anything Deezer does not label as a single/EP is treated as an album so
        # an unfamiliar record_type stays visible rather than vanishing.
        if record_type in ("single", "ep"):
            singles_eps.append(entry)
        else:
            albums.append(entry)
    return {"albums": albums, "singles_eps": singles_eps}


def _gather(
    jobs: tuple[tuple[str, Any], ...],
    failures: list[dict[str, str]],
) -> dict[str, Any]:
    """Run independent fetchers concurrently under gevent, serially without it.

    A greenlet that raises stores the error on `.exception` and leaves `.value`
    as None instead of re-raising, and one that outruns `joinall`'s deadline
    leaves both unset — so failures have to be read from `.successful()` rather
    than caught around `.value`, which would silently yield None.
    """
    results: dict[str, Any] = {}
    if not _HAS_GEVENT:
        for label, fn in jobs:
            try:
                results[label] = fn()
            except Exception as exc:
                logger.info("Deezer %s fetch failed: %s", label, exc)
                failures.append({"source": "deezer", "error": sanitize_cli_message(str(exc))})
        return results

    spawned = [(label, spawn(fn)) for label, fn in jobs]
    joinall([job for _, job in spawned], timeout=catalog_service.DEEZER_FANOUT_TIMEOUT_SEC)
    for label, job in spawned:
        if job.successful():
            results[label] = job.value
            continue
        exc = job.exception
        reason = sanitize_cli_message(str(exc)) if exc else "timed out"
        job.kill(block=False)
        logger.info("Deezer %s fetch failed: %s", label, reason)
        failures.append({"source": "deezer", "error": reason})
    return results




_VARIOUS_ARTISTS_DEEZER_ID = "5080"


def _deezer_album_credits(data: dict[str, Any]) -> tuple[str, list[str], str | None]:
    """The album's credited artists, and the one artist whose other releases
    "More by" may list: only a single credited artist that is not Deezer's
    Various Artists bucket."""
    artist_row = data.get("artist") if isinstance(data.get("artist"), dict) else {}
    credits = deezer_catalog.main_contributors(data)
    if not credits:
        fallback_name = catalog_service.clean(artist_row.get("name"))
        if fallback_name:
            credits = [(str(artist_row.get("id") or "").strip(), fallback_name)]
    names = [name for _, name in credits]
    artist_deezer_id: str | None = None
    if len(credits) == 1:
        candidate_id = credits[0][0] or str(artist_row.get("id") or "").strip()
        if candidate_id and candidate_id != _VARIOUS_ARTISTS_DEEZER_ID:
            artist_deezer_id = candidate_id
    return ", ".join(names), names, artist_deezer_id


def _deezer_album_profile(album_id: str, library_keys: set[str] | None = None) -> dict[str, Any]:
    data = deezer_catalog.deezer_get(f"album/{album_id}")
    artist_row = data.get("artist") if isinstance(data.get("artist"), dict) else {}
    title = catalog_service.clean(data.get("title"))
    artist, artists, artist_deezer_id = _deezer_album_credits(data)
    cover = deezer.image(data, "cover")
    release_date = _iso_release_date(data.get("release_date"))
    year = extract_year(data.get("release_date"))
    label = catalog_service.clean(data.get("label"), 200)
    record_type = catalog_service.norm(data.get("record_type")) or "album"
    genre_names: list[str] = []
    genres = data.get("genres") if isinstance(data.get("genres"), dict) else {}
    gen_data = genres.get("data") if isinstance(genres.get("data"), list) else []
    for g in gen_data:
        if isinstance(g, dict) and g.get("name"):
            genre_names.append(str(g["name"]).strip())

    track_rows = data.get("tracks") if isinstance(data.get("tracks"), dict) else {}
    embedded = track_rows.get("data") if isinstance(track_rows.get("data"), list) else []
    embedded = [row for row in embedded if isinstance(row, dict)]
    # The tracks endpoint names each song's own artist but not the record it is
    # on, which is this one.
    this_album = {
        "id": data.get("id") or album_id,
        "title": title,
        "cover_xl": data.get("cover_xl"),
        "cover_big": data.get("cover_big"),
        "cover_medium": data.get("cover_medium"),
        "release_date": data.get("release_date"),
        "artist": artist_row,
    }
    tracklist: list[dict[str, Any]] = []
    for row in _deezer_album_tracks(album_id, embedded):
        # A row's own album fields win; this record fills what it leaves out,
        # including the release date its listing never carries.
        own = row.get("album") if isinstance(row.get("album"), dict) else {}
        row = {**row, "album": {**this_album, **{k: v for k, v in own.items() if v not in (None, "")}}}
        item = deezer_catalog.track_to_catalog_item(row, library_keys)
        if item:
            tracklist.append(item)

    duration = duration_seconds(data.get("duration")) or 0
    if not duration:
        duration = sum(int(item.get("duration") or 0) for item in tracklist)

    return {
        "title": title,
        "artist": artist,
        "artists": artists,
        "artist_deezer_id": artist_deezer_id,
        "cover": cover,
        "year": year,
        "release_date": release_date,
        "label": label,
        "duration": duration,
        "record_type": record_type,
        "genre": ", ".join(genre_names) if genre_names else "",
        "tracklist": tracklist,
    }


_ALBUM_TRACKS_PAGE = 100
# No release runs this long; it bounds a malformed `total`.
_ALBUM_TRACKS_MAX = 500


def _deezer_album_tracks(album_id: str, embedded: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Every song on the record, each with its disc and position.

    `album/{id}` embeds at most 25 tracks and says nothing about the rest, so a
    47-track reissue showed 25 on its page. `album/{id}/tracks` lists them all,
    with the disc and position a download needs. The embedded rows stay the
    answer when that listing fails before it has more to offer.
    """
    rows: list[dict[str, Any]] = []
    try:
        while len(rows) < _ALBUM_TRACKS_MAX:
            page = deezer_catalog.deezer_get(f"album/{album_id}/tracks", {"limit": _ALBUM_TRACKS_PAGE, "index": len(rows)})
            listed = page.get("data") if isinstance(page.get("data"), list) else []
            listed = [row for row in listed if isinstance(row, dict)]
            rows.extend(listed)
            if not listed or len(rows) >= int(page.get("total") or 0):
                break
    except Exception as exc:
        logger.info("Album tracklist fetch failed for %s: %s", album_id, exc)
    return rows if len(rows) >= len(embedded) else embedded


#: What an artist released under their own name. A compilation is somebody
#: else's record that happens to include them.
_DISCOGRAPHY_RELEASE_TYPES = ("album", "single", "ep")
#: Listings fetched at once: well inside Deezer's quota with room for pages.
_DISCOGRAPHY_WORKERS = 3
#: No artist anyone means to keep whole runs past this; it bounds a runaway.
_DISCOGRAPHY_MAX_SONGS = 2000
_discography_memo = Memo(ttl_sec=600, maxsize=64)


def _deezer_artist_discography(artist_id: str) -> dict[str, Any]:
    """Everything an artist released under their own name, each song once.

    Albums come first, then singles and EPs, so a recording that came out on a
    single and again on its album (one ISRC) is kept once, on the album. A
    release whose listing cannot be read is named in `partial_failures` rather
    than silently missing.
    """
    artist = deezer_catalog.deezer_get(f"artist/{artist_id}")
    name = catalog_service.clean(artist.get("name"))
    releases = _deezer_artist_releases(artist_id)
    ordered = [
        release
        for kind in _DISCOGRAPHY_RELEASE_TYPES
        for release in releases["albums"] + releases["singles_eps"]
        if release["record_type"] == kind
    ]
    with ThreadPoolExecutor(max_workers=_DISCOGRAPHY_WORKERS) as pool:
        listings = list(pool.map(lambda release: _deezer_album_tracks(release["deezer_id"], []), ordered))

    seen: set[str] = set()
    kept_releases: list[dict[str, Any]] = []
    tracklist: list[dict[str, Any]] = []
    failures: list[str] = []
    truncated = False
    for release, rows in zip(ordered, listings):
        if not rows:
            failures.append(release["title"])
            continue
        this_release = {
            "id": release["deezer_id"],
            "title": release["title"],
            "cover_xl": release["cover"],
            "release_date": release.get("year"),
            # The discography is this artist's own records: albums, singles
            # and EPs, never a compilation.
            "artist": {"name": name},
        }
        songs: list[dict[str, Any]] = []
        for row in rows:
            item = deezer_catalog.track_to_catalog_item({**row, "album": this_release})
            if not item:
                continue
            isrc = item["external_ids"].get("isrc")
            identity = f"isrc:{isrc}" if isrc else item["id"]
            if identity in seen:
                continue
            if len(tracklist) + len(songs) >= _DISCOGRAPHY_MAX_SONGS:
                truncated = True
                break
            seen.add(identity)
            songs.append(item)
        if songs:
            kept_releases.append({
                "deezer_id": release["deezer_id"],
                "title": release["title"],
                "record_type": release["record_type"],
                "year": release["year"],
                "track_ids": [song["id"] for song in songs],
            })
            tracklist.extend(songs)
        if truncated:
            break
    return {
        "artist": name,
        "deezer_id": artist_id,
        "releases": kept_releases,
        "tracklist": tracklist,
        "partial_failures": failures,
        "truncated": truncated,
    }


@catalog_bp.route("/api/catalog/artist/discography", methods=["GET"])
@rate_limit("catalog_artist_discography", limit=30, window_sec=60)
def catalog_artist_discography():
    """An artist's albums, singles and EPs as one list of songs, each once."""
    from shared.migration.collections import valid_deezer_id

    deezer_id = valid_deezer_id(request.args.get("deezer_id"))
    if not deezer_id:
        return jsonify({"error": "deezer_id is required"}), 400
    try:
        body, _cached = catalog_service.memo_resolve(
            _discography_memo, f"discography:{deezer_id}", lambda: _deezer_artist_discography(deezer_id)
        )
    except Exception as exc:
        logger.info("Discography of %s could not be read: %s", deezer_id, exc)
        return jsonify({"error": "The discography could not be read"}), 502
    return jsonify(body)


@catalog_bp.route("/api/catalog/artist/download", methods=["POST"])
@require_scope(SCOPE_LIBRARY_WRITE, allow_trusted_network=True)
@rate_limit("catalog_artist_download", limit=10, window_sec=60)
def catalog_artist_download():
    """Download an artist's albums, singles and EPs: every song the library lacks."""
    from shared.migration.collections import artist_manifest, start_collection_download, valid_deezer_id
    from shared.user_context import require_user_id

    data = request.get_json(silent=True) or {}
    deezer_id = valid_deezer_id(data.get("deezer_id"))
    if not deezer_id:
        return jsonify({"error": "deezer_id is required"}), 400
    try:
        discography, _cached = catalog_service.memo_resolve(
            _discography_memo, f"discography:{deezer_id}", lambda: _deezer_artist_discography(deezer_id)
        )
    except Exception as exc:
        logger.info("Artist download could not read %s: %s", deezer_id, exc)
        return jsonify({"error": "The discography could not be read"}), 502
    manifest = artist_manifest(deezer_id, discography)
    if not manifest.tracks:
        return jsonify({"error": "The artist has no songs"}), 404
    job = start_collection_download(manifest, catalog_service.library_tracks(), require_user_id())
    return jsonify({"job": job}), 202


@catalog_bp.route("/api/catalog/artist/download", methods=["GET"])
@rate_limit("catalog_artist_download_status", limit=240, window_sec=60)
def catalog_artist_download_status():
    """The latest download of an artist's discography, song by song, or null."""
    from shared.migration.collections import artist_provider, collection_job, valid_deezer_id

    deezer_id = valid_deezer_id(request.args.get("deezer_id"))
    if not deezer_id:
        return jsonify({"error": "deezer_id is required"}), 400
    return jsonify({"job": collection_job(artist_provider(deezer_id))})


def _resolve_album_deezer_id(name: str, artist: str) -> str | None:
    """Search Deezer for an album by name + artist, return best match deezer_id.

    A plain album search: Deezer's field syntax (`album:"…" artist:"…"`)
    stopped answering in October 2026 and returned nothing, so every album
    looked up by name came back unresolved.
    """
    data = deezer_catalog.deezer_get("search/album", {"q": f"{name} {artist}".strip(), "limit": 10})
    rows = [row for row in (data.get("data") if isinstance(data.get("data"), list) else []) if isinstance(row, dict)]
    name_folded, artist_folded = fold_text(name), fold_text(artist)

    def album_id(row: dict) -> str:
        return str(row.get("id") or "")

    def title_matches(row: dict) -> bool:
        return fold_text(catalog_service.clean(row.get("title"))) == name_folded

    def edition_of(row: dict) -> bool:
        # "Abbey Road (Remastered 2009)" is still Abbey Road.
        bare = re.sub(r"\s*[\(\[][^\)\]]*[\)\]]", "", catalog_service.clean(row.get("title")))
        return fold_text(bare) == name_folded

    def artist_matches(row: dict) -> bool:
        artist_row = row.get("artist") if isinstance(row.get("artist"), dict) else {}
        return not artist_folded or fold_text(catalog_service.clean(artist_row.get("name"))) == artist_folded

    # The artist asked for outranks a title: another artist's exact title is
    # a cover or a tribute, the artist's own edition is the record.
    for wanted in (
        lambda row: title_matches(row) and artist_matches(row),
        lambda row: edition_of(row) and artist_matches(row),
        artist_matches,
        title_matches,
        lambda row: True,
    ):
        for row in rows:
            if album_id(row) and wanted(row):
                return album_id(row)
    return None


@catalog_bp.route("/api/catalog/artist", methods=["GET"])
@rate_limit("catalog_artist", limit=60, window_sec=60)
def catalog_artist():
    name = catalog_service.clean(request.args.get("name", ""), 200)
    if len(name) < 1:
        return jsonify({"error": "name is required"}), 400
    deezer_id = catalog_service.clean(request.args.get("deezer_id", ""), 32) or None

    cache_key = f"artist:{deezer_id or name.casefold()}"
    body, cached = catalog_service.memo_resolve(
        catalog_service.artist_memo, cache_key, lambda: _artist_profile_uncached(name, deezer_id)
    )
    body["cached"] = cached
    return jsonify(body)


def _artist_profile_uncached(name: str, deezer_id: str | None) -> dict[str, Any]:
    now = time.time()
    library_keys = catalog_service.library_artist_keys(name)

    resolved_id: str | None = None
    candidates: list[dict[str, Any]] = []
    metadata: dict[str, Any] = {}
    top_tracks: list[dict[str, Any]] = []
    albums: list[dict[str, Any]] = []
    singles_eps: list[dict[str, Any]] = []
    related: list[dict[str, Any]] = []
    resolved = False
    failures: list[dict[str, str]] = []

    try:
        resolved_id, candidates = deezer_catalog.resolve_artist_id(name, deezer_id)
    except Exception as exc:
        logger.info("Artist resolve failed for %r: %s", name, exc)
        failures.append({"source": "deezer", "error": sanitize_cli_message(str(exc))})

    if resolved_id:
        resolved = True
        artist_id = resolved_id
        results = _gather(
            (
                ("profile", lambda: _deezer_artist_profile(artist_id)),
                ("top", lambda: deezer_catalog.artist_top_tracks(artist_id, 50, library_keys)),
                ("releases", lambda: _deezer_artist_releases(artist_id, 100)),
                ("related", lambda: deezer_catalog.related_artists(artist_id, 20)),
            ),
            failures,
        )
        metadata = results.get("profile") or {}
        top_tracks = results.get("top") or []
        releases = results.get("releases") or {}
        albums = releases.get("albums") or []
        singles_eps = releases.get("singles_eps") or []
        related = results.get("related") or []

    dated_releases = [entry for entry in (*albums, *singles_eps) if _release_sort_key(entry)]
    latest_release = max(dated_releases, key=_release_sort_key) if dated_releases else None

    return {
        "name": name,
        "resolved": resolved,
        "deezer_id": resolved_id,
        "metadata": metadata,
        "candidates": candidates,
        "top_tracks": top_tracks,
        "albums": albums,
        "singles_eps": singles_eps,
        "latest_release": latest_release,
        "related_artists": related,
        "in_library": bool(library_keys),
        "partial_failures": failures,
        "cached": False,
        "generated_at": int(now),
    }


@catalog_bp.route("/api/catalog/album", methods=["GET"])
@rate_limit("catalog_album", limit=60, window_sec=60)
def catalog_album():
    from shared.catalog_reconciliation import annotate_owned_recordings
    name = catalog_service.clean(request.args.get("name", ""), 200)
    if len(name) < 1:
        return jsonify({"error": "name is required"}), 400
    artist = catalog_service.clean(request.args.get("artist", ""), 200) or None
    deezer_id = catalog_service.clean(request.args.get("deezer_id", ""), 32) or None

    tracks = catalog_service.library_tracks()
    library_db = getattr(tracks, 'search_db', None)
    revision = library_db.get_library_revision() if library_db is not None else ''
    cache_key = f"album:{deezer_id or (name + '|' + (artist or '')).casefold()}|library:{revision}"
    body, cached = catalog_service.memo_resolve(
        catalog_service.album_memo, cache_key, lambda: _album_profile_uncached(name, artist, deezer_id)
    )
    body["cached"] = cached
    return jsonify(annotate_owned_recordings(body, tracks, instance_db()))


@catalog_bp.route("/api/catalog/album/reconcile", methods=["POST"])
@require_scope(SCOPE_LIBRARY_WRITE, allow_trusted_network=True)
@rate_limit("catalog_album_reconcile", limit=30, window_sec=60)
def catalog_album_reconcile():
    """Repair verified orphan recordings from an authoritative album listing."""
    from shared.catalog_reconciliation import annotate_owned_recordings, reconcile_album
    from shared.library_lifecycle import LibraryPersistenceError
    from shared.migration.collections import valid_deezer_id
    from shared.realtime import emit_to_user

    data = request.get_json(silent=True) or {}
    deezer_id = valid_deezer_id(data.get('deezer_id'))
    if not deezer_id:
        return jsonify({'error': 'deezer_id is required'}), 400
    try:
        # Never accept release metadata or a local track id from the caller.
        profile = _deezer_album_profile(deezer_id)
    except Exception as exc:
        logger.info('Album reconciliation could not read %s: %s', deezer_id, exc)
        return jsonify({'error': 'The album could not be read'}), 502
    lib = catalog_service.engine_api()['get_library']()
    db = instance_db()
    try:
        updated = reconcile_album(lib, profile['tracklist'], db)
    except LibraryPersistenceError as exc:
        return jsonify({'error': str(exc), 'code': exc.code}), exc.status
    if updated:
        request_scope.invalidate('catalog_library')
        catalog_service.album_memo.clear()
        catalog_service.artist_memo.clear()
        catalog_service.catalog_memo.clear()
        emit_to_user('library_updated')
    profile.update(deezer_id=deezer_id, resolved=True, cached=False, partial_failures=[])
    return jsonify(annotate_owned_recordings(profile, lib.metadata.tracks if lib.metadata else [], db))


@catalog_bp.route("/api/catalog/album/download", methods=["POST"])
@require_scope(SCOPE_LIBRARY_WRITE, allow_trusted_network=True)
@rate_limit("catalog_album_download", limit=20, window_sec=60)
def catalog_album_download():
    """Download every song on an album that the library does not hold yet.

    The tracklist is read here rather than taken from the page, so what is
    downloaded is the record itself, whole, and nothing a client made up.
    """
    from shared.migration.collections import album_manifest, start_collection_download, valid_deezer_id
    from shared.user_context import require_user_id

    data = request.get_json(silent=True) or {}
    deezer_id = valid_deezer_id(data.get("deezer_id"))
    if not deezer_id:
        return jsonify({"error": "deezer_id is required"}), 400
    try:
        profile = _deezer_album_profile(deezer_id)
    except Exception as exc:
        logger.info("Album download could not read %s: %s", deezer_id, exc)
        return jsonify({"error": "The album could not be read"}), 502
    manifest = album_manifest(deezer_id, profile)
    if not manifest.tracks:
        return jsonify({"error": "The album has no songs"}), 404
    job = start_collection_download(manifest, catalog_service.library_tracks(), require_user_id())
    return jsonify({"job": job}), 202


@catalog_bp.route("/api/catalog/album/download", methods=["GET"])
@rate_limit("catalog_album_download_status", limit=240, window_sec=60)
def catalog_album_download_status():
    """The latest download of an album, song by song, or null."""
    from shared.migration.collections import album_provider, collection_job, valid_deezer_id

    deezer_id = valid_deezer_id(request.args.get("deezer_id"))
    if not deezer_id:
        return jsonify({"error": "deezer_id is required"}), 400
    return jsonify({"job": collection_job(album_provider(deezer_id))})


def _album_profile_uncached(name: str, artist: str | None, deezer_id: str | None) -> dict[str, Any]:
    now = time.time()
    library_keys = catalog_service.library_album_keys(name, artist or "")

    title = name
    album_artist = artist or ""
    album_artists: list[str] = [album_artist] if album_artist else []
    artist_deezer_id: str | None = None
    cover = ""
    year: int | None = None
    release_date = ""
    label = ""
    duration = 0
    record_type = ""
    genre = ""
    tracklist: list[dict[str, Any]] = []
    more_by_artist: list[dict[str, Any]] = []
    resolved = False
    failures: list[dict[str, str]] = []

    if not deezer_id and artist:
        try:
            deezer_id = _resolve_album_deezer_id(name, artist)
        except Exception as exc:
            logger.info("Album resolve failed for %r: %s", name, exc)
            failures.append({"source": "deezer", "error": sanitize_cli_message(str(exc))})

    if deezer_id:
        try:
            profile = _deezer_album_profile(deezer_id, library_keys)
            title = profile["title"] or title
            album_artist = profile["artist"] or album_artist
            raw_artists = profile.get("artists")
            if isinstance(raw_artists, list) and raw_artists:
                album_artists = [str(a).strip() for a in raw_artists if str(a).strip()]
            else:
                album_artists = [album_artist] if album_artist else []
            artist_deezer_id = profile.get("artist_deezer_id") or None
            cover = profile["cover"]
            year = profile["year"]
            release_date = profile.get("release_date") or ""
            label = profile.get("label") or ""
            duration = int(profile.get("duration") or 0)
            record_type = profile.get("record_type") or ""
            genre = profile["genre"]
            tracklist = profile["tracklist"]
            resolved = True
        except Exception as exc:
            logger.info("Album profile fetch failed for %s: %s", deezer_id, exc)
            failures.append({"source": "deezer", "error": sanitize_cli_message(str(exc))})

    if resolved and artist_deezer_id:
        results = _gather(
            (("more_by_artist", lambda: _deezer_artist_releases(artist_deezer_id, 100)),),
            failures,
        )
        releases = results.get("more_by_artist") or {}
        seen_ids: set[str] = {str(deezer_id)}
        candidates: list[dict[str, Any]] = []
        for entry in (*(releases.get("albums") or []), *(releases.get("singles_eps") or [])):
            entry_id = str(entry.get("deezer_id") or "")
            if not entry_id or entry_id in seen_ids:
                continue
            seen_ids.add(entry_id)
            candidates.append(entry)
        candidates.sort(key=_release_sort_key, reverse=True)
        more_by_artist = candidates[:12]

    return {
        "title": title,
        "artist": album_artist,
        "artists": album_artists,
        "artist_deezer_id": artist_deezer_id,
        "cover": cover,
        "year": year,
        "release_date": release_date,
        "label": label,
        "duration": duration,
        "record_type": record_type,
        "genre": genre,
        "tracklist": tracklist,
        "more_by_artist": more_by_artist,
        # The record the page settled on, when the link only named it: what a
        # download of the whole album asks for.
        "deezer_id": deezer_id if resolved else None,
        "in_library": bool(library_keys),
        "resolved": resolved,
        "partial_failures": failures,
        "cached": False,
        "generated_at": int(now),
    }
