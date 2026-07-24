"""
Car-friendly browse and playback metadata routes.

These routes intentionally expose a small, stable tree for native car clients.
They do not replace the full library API; they normalize the content shape that
CarPlay, Android Auto, and Bluetooth-style Now Playing surfaces need.
"""

from __future__ import annotations

from urllib.parse import quote, unquote

from flask import Blueprint, jsonify

from shared.hardening import SCOPE_LIBRARY_READ, require_scope

car_bp = Blueprint("car", __name__, url_prefix="")

MAX_CAR_ITEMS = 200


def _get_api():
    from shared.api import get_core, get_track_by_id, get_playback_state, get_scope_from_request
    from shared.api import get_favourites_manager

    return {
        "get_core": get_core,
        "get_track_by_id": get_track_by_id,
        "get_playback_state": get_playback_state,
        "get_scope_from_request": get_scope_from_request,
        "favourites_manager": get_favourites_manager(),
    }


def _quote_id(value: str) -> str:
    return quote(str(value or ""), safe="")


def _collection_item(item_id: str, title: str, subtitle: str = "") -> dict:
    return {
        "id": item_id,
        "kind": "collection",
        "title": title,
        "subtitle": subtitle,
        "artist": "",
        "album": "",
        "duration_sec": None,
        "artwork_url": None,
        "stream_url": None,
        "is_browsable": True,
        "is_playable": False,
    }


def _track_dict(track) -> dict:
    if hasattr(track, "to_dict"):
        return track.to_dict()
    if isinstance(track, dict):
        return dict(track)
    return {
        "id": getattr(track, "id", ""),
        "title": getattr(track, "title", ""),
        "artist": getattr(track, "artist", ""),
        "album": getattr(track, "album", ""),
        "duration": getattr(track, "duration", None),
        "media_kind": getattr(track, "media_kind", None),
    }


def _track_item(track) -> dict:
    data = _track_dict(track)
    track_id = str(data.get("id") or "")
    title = str(data.get("title") or "Untitled")
    artist = str(data.get("artist") or "")
    album = str(data.get("album") or "")
    duration = data.get("duration_sec", data.get("duration"))
    return {
        "id": track_id,
        "kind": data.get("media_kind") or "track",
        "track_id": track_id,
        "title": title,
        "subtitle": " - ".join(part for part in (artist, album) if part),
        "artist": artist,
        "album": album,
        "duration_sec": int(duration) if isinstance(duration, (int, float)) else None,
        "artwork_url": f"/api/static/cover/{_quote_id(track_id)}" if track_id else None,
        "stream_url": f"/api/static/stream/{_quote_id(track_id)}" if track_id else None,
        "is_browsable": False,
        "is_playable": bool(track_id),
    }


def _load_metadata(api):
    lib, _, _ = api["get_core"]()
    lib.refresh_if_stale()
    if not lib.metadata:
        lib.sync_library()
    return lib, lib.metadata


def _tracks_by_id(metadata) -> dict[str, object]:
    return {str(track.id): track for track in getattr(metadata, "tracks", [])}


def _playlist_items(metadata) -> list[dict]:
    playlists = getattr(metadata, "playlists", {}) or {}
    items = []
    for name, track_ids in playlists.items():
        count = len(track_ids or [])
        subtitle = f"{count} track" if count == 1 else f"{count} tracks"
        items.append(_collection_item(f"playlist:{_quote_id(name)}", str(name), subtitle))
    return items


def _podcast_items(metadata) -> list[dict]:
    subscriptions = getattr(metadata, "podcast_subscriptions", []) or []
    if subscriptions:
        items = []
        for sub in subscriptions:
            title = getattr(sub, "title", "") if not isinstance(sub, dict) else sub.get("title", "")
            author = getattr(sub, "author", "") if not isinstance(sub, dict) else sub.get("author", "")
            sub_id = getattr(sub, "id", "") if not isinstance(sub, dict) else sub.get("id", "")
            items.append(_collection_item(f"podcast:{_quote_id(sub_id or title)}", title or "Podcast", author or "Podcast"))
        return items
    return [
        _track_item(track)
        for track in getattr(metadata, "tracks", [])
        if getattr(track, "media_kind", None) == "podcast_episode"
    ][:MAX_CAR_ITEMS]


def _home_items(metadata) -> list[dict]:
    playlists = getattr(metadata, "playlists", {}) or {}
    tracks = getattr(metadata, "tracks", []) or []
    podcast_count = len(getattr(metadata, "podcast_subscriptions", []) or [])
    if not podcast_count:
        podcast_count = len([t for t in tracks if getattr(t, "media_kind", None) == "podcast_episode"])

    return [
        _collection_item("recently-played", "Recently Played", "Resume the latest Soundsible session"),
        _collection_item("favourites", "Favourites", "Saved tracks"),
        _collection_item("playlists", "Playlists", f"{len(playlists)} playlists"),
        _collection_item("podcasts", "Podcasts", f"{podcast_count} shows or episodes"),
        _collection_item("radio", "Radio Seeds", "Choose a track to continue from"),
        _collection_item("all-tracks", "All Tracks", f"{len(tracks)} tracks"),
    ]


@car_bp.route("/api/car/home", methods=["GET"])
@require_scope(SCOPE_LIBRARY_READ, allow_trusted_network=True)
def get_car_home():
    api = _get_api()
    _, metadata = _load_metadata(api)
    if not metadata:
        return jsonify({"items": [], "sections": [], "status": "library_not_loaded"}), 404

    items = _home_items(metadata)
    return jsonify({
        "items": items,
        "sections": [{"id": "home", "title": "Soundsible", "items": items}],
        "status": "ok",
    })


@car_bp.route("/api/car/items/<path:item_id>", methods=["GET"])
@require_scope(SCOPE_LIBRARY_READ, allow_trusted_network=True)
def get_car_items(item_id: str):
    api = _get_api()
    _, metadata = _load_metadata(api)
    if not metadata:
        return jsonify({"items": [], "status": "library_not_loaded"}), 404

    tracks = list(getattr(metadata, "tracks", []) or [])
    by_id = _tracks_by_id(metadata)
    item_id = str(item_id or "")

    if item_id == "all-tracks":
        return jsonify({"id": item_id, "items": [_track_item(t) for t in tracks[:MAX_CAR_ITEMS]], "status": "ok"})

    if item_id == "playlists":
        return jsonify({"id": item_id, "items": _playlist_items(metadata), "status": "ok"})

    if item_id.startswith("playlist:"):
        name = unquote(item_id.split(":", 1)[1])
        playlist_ids = (getattr(metadata, "playlists", {}) or {}).get(name)
        if playlist_ids is None:
            return jsonify({"error": "Playlist not found"}), 404
        items = [_track_item(by_id[tid]) for tid in playlist_ids if tid in by_id]
        return jsonify({"id": item_id, "title": name, "items": items[:MAX_CAR_ITEMS], "status": "ok"})

    if item_id == "favourites":
        favourite_ids = api["favourites_manager"].get_all()
        items = [_track_item(by_id[tid]) for tid in favourite_ids if tid in by_id]
        return jsonify({"id": item_id, "items": items[:MAX_CAR_ITEMS], "status": "ok"})

    if item_id == "recently-played":
        scope = api["get_scope_from_request"]()
        state = api["get_playback_state"](scope) or {}
        track = state.get("track")
        if not track and state.get("track_id") in by_id:
            track = by_id[state["track_id"]]
        items = [_track_item(track)] if track else []
        return jsonify({"id": item_id, "items": items, "playback_state": state, "status": "ok"})

    if item_id == "podcasts":
        return jsonify({"id": item_id, "items": _podcast_items(metadata), "status": "ok"})

    if item_id == "radio":
        seed_items = [_track_item(t) for t in tracks[:MAX_CAR_ITEMS]]
        for item in seed_items:
            item["kind"] = "radio_seed"
            item["radio_seed_track_id"] = item.get("track_id")
        return jsonify({"id": item_id, "items": seed_items, "status": "ok"})

    return jsonify({"error": "Car item not found"}), 404
