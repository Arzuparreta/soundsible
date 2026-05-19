"""Local-first discovery settings, events, and deterministic recommendations."""

from __future__ import annotations

import json
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from shared.models import LibraryMetadata, Track
from shared.runtime import get_config_dir
from shared.telemetry import emit

SETTINGS_VERSION = 1
DEFAULT_SETTINGS = {
    "v": SETTINGS_VERSION,
    "learning_enabled": True,
}

POSITIVE_LISTENING_EVENTS = {
    "music_played_30s",
    "music_saved_to_library",
    "music_added_to_playlist",
    "music_added_to_queue",
    "music_started_radio",
    "music_search_played",
    "podcast_episode_played_30s",
    "podcast_subscribed",
    "podcast_episode_saved",
    "podcast_search_opened",
}


def _settings_path() -> Path:
    return get_config_dir() / "discovery_settings.json"


def load_discovery_settings() -> dict[str, Any]:
    path = _settings_path()
    data: dict[str, Any] = {}
    try:
        if path.exists():
            raw = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                data = raw
    except Exception:
        data = {}
    out = dict(DEFAULT_SETTINGS)
    if isinstance(data.get("learning_enabled"), bool):
        out["learning_enabled"] = data["learning_enabled"]
    return out


def save_discovery_settings(patch: dict[str, Any]) -> dict[str, Any]:
    current = load_discovery_settings()
    if "learning_enabled" in patch:
        current["learning_enabled"] = bool(patch["learning_enabled"])
    current["v"] = SETTINGS_VERSION
    path = _settings_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(current, indent=2, sort_keys=True), encoding="utf-8")
    return current


def _clean_str(value: Any, max_len: int = 220) -> str:
    if value is None:
        return ""
    text = str(value).strip()
    if len(text) > max_len:
        return text[:max_len]
    return text


def emit_discovery_event(event: str, payload: dict[str, Any] | None = None) -> bool:
    """Append one local listening event when discovery learning is enabled."""
    event_name = _clean_str(event, 80)
    if event_name not in POSITIVE_LISTENING_EVENTS:
        raise ValueError(f"Unsupported discovery event {event_name!r}")
    if not load_discovery_settings().get("learning_enabled", True):
        return False

    payload = payload if isinstance(payload, dict) else {}
    safe: dict[str, Any] = {
        "v": 1,
        "event": event_name,
        "ts": int(time.time()),
    }
    for key in (
        "media_type",
        "track_id",
        "title",
        "artist",
        "album",
        "source",
        "youtube_id",
        "deezer_id",
        "playlist_name",
        "query",
        "podcast_feed_id",
        "podcast_episode_id",
        "podcast_show_title",
        "podcast_author",
        "itunes_collection_id",
    ):
        value = payload.get(key)
        if value is None:
            continue
        if isinstance(value, (int, float, bool)):
            safe[key] = value
        else:
            safe[key] = _clean_str(value)
    emit("listening-events", safe)
    return True


def _norm(value: Any) -> str:
    return str(value or "").strip().lower()


def _track_cover(track: Track) -> str:
    return getattr(track, "cover_art_key", None) or ""


def _external_ids_for_track(track: Track) -> dict[str, Any]:
    out: dict[str, Any] = {}
    if getattr(track, "youtube_id", None):
        out["youtube_id"] = track.youtube_id
    if getattr(track, "isrc", None):
        out["isrc"] = track.isrc
    if getattr(track, "musicbrainz_id", None):
        out["musicbrainz_id"] = track.musicbrainz_id
    return out


def _music_item(
    track: Track,
    *,
    reason: str,
    reason_code: str,
    score: float,
    source: str = "library",
    in_library: bool = True,
    saved: bool = True,
) -> dict[str, Any]:
    return {
        "id": f"music:{track.id}",
        "media_type": "music_track",
        "track_id": track.id,
        "title": track.title or "Unknown",
        "artist": track.artist or track.album_artist or "",
        "album": track.album or "",
        "duration": int(track.duration or 0),
        "cover": _track_cover(track),
        "source": source,
        "reason": reason,
        "reason_code": reason_code,
        "score": round(float(score), 4),
        "confidence": 1.0 if in_library else 0.65,
        "action_state": {
            "in_library": bool(in_library),
            "saved": bool(saved),
            "playable": True,
            "downloadable": not in_library,
            "needs_resolution": False,
        },
        "external_ids": _external_ids_for_track(track),
    }


def build_music_recommendations(
    metadata: LibraryMetadata | None,
    favourite_ids: Iterable[str] | None = None,
    limit: int = 24,
) -> dict[str, Any]:
    tracks = list(metadata.tracks if metadata and metadata.tracks else [])
    fav_ids = [str(x) for x in (favourite_ids or []) if x]
    fav_set = set(fav_ids)
    playlists = metadata.playlists if metadata and isinstance(metadata.playlists, dict) else {}

    if not tracks:
        return {
            "items": [],
            "sections": [
                {
                    "id": "cold_start",
                    "title": "Start your library",
                    "reason": "Add music, import playlists, or search to teach Soundsible what to recommend.",
                    "item_ids": [],
                }
            ],
            "settings": load_discovery_settings(),
        }

    by_id = {t.id: t for t in tracks}
    items: list[dict[str, Any]] = []
    seen: set[str] = set()

    def add(track: Track, **kwargs: Any) -> None:
        if not track or track.id in seen or len(items) >= limit:
            return
        seen.add(track.id)
        items.append(_music_item(track, **kwargs))

    for idx, tid in enumerate(fav_ids):
        track = by_id.get(tid)
        if track:
            add(
                track,
                reason="A favourite in your library.",
                reason_code="library_favourite",
                score=1.0 - idx * 0.01,
            )

    playlist_members: dict[str, list[str]] = {}
    for name, ids in playlists.items():
        if isinstance(ids, list):
            playlist_members[str(name)] = [str(x) for x in ids if str(x) in by_id]
    for name, ids in sorted(playlist_members.items(), key=lambda kv: len(kv[1]), reverse=True):
        for idx, tid in enumerate(ids[:6]):
            track = by_id.get(tid)
            if track:
                add(
                    track,
                    reason=f'From your playlist "{name}".',
                    reason_code="playlist_taste",
                    score=0.9 - idx * 0.01,
                )

    artist_counts: dict[str, int] = {}
    for track in tracks:
        artist = _norm(track.album_artist or track.artist)
        artist_counts[artist] = artist_counts.get(artist, 0) + 1
    strong_artists = {artist for artist, count in artist_counts.items() if artist and count >= 2}
    for track in tracks:
        if _norm(track.album_artist or track.artist) in strong_artists:
            add(
                track,
                reason=f"You have several tracks by {track.album_artist or track.artist}.",
                reason_code="artist_affinity",
                score=0.78,
            )

    sorted_recent = sorted(tracks, key=lambda t: _clean_str(getattr(t, "id", "")), reverse=True)
    for track in sorted_recent:
        add(
            track,
            reason="Ready from your local library.",
            reason_code="library_owned",
            score=0.62 if track.id not in fav_set else 0.7,
        )

    return {
        "items": items[:limit],
        "sections": [
            {
                "id": "made_for_your_library",
                "title": "Made for Your Library",
                "reason": "Local-first picks from favourites, playlists, and library structure.",
                "item_ids": [item["id"] for item in items[:limit]],
            }
        ],
        "settings": load_discovery_settings(),
    }


def _podcast_item(row: dict[str, Any], *, reason: str, reason_code: str, score: float) -> dict[str, Any]:
    feed_url = _clean_str(row.get("rss_url") or row.get("feed_url"), 400)
    itunes_id = _clean_str(row.get("itunes_collection_id"))
    stable = row.get("id") or itunes_id or feed_url or row.get("title") or "podcast"
    return {
        "id": f"podcast:{_clean_str(stable, 160)}",
        "media_type": "podcast_show",
        "title": _clean_str(row.get("title"), 180) or "Podcast",
        "author": _clean_str(row.get("author"), 180),
        "image_url": _clean_str(row.get("image_url"), 400),
        "source": "subscription" if row.get("rss_url") else "itunes_podcast",
        "reason": reason,
        "reason_code": reason_code,
        "score": round(float(score), 4),
        "confidence": 1.0 if row.get("rss_url") else 0.7,
        "action_state": {
            "subscribed": bool(row.get("rss_url")),
            "playable": bool(feed_url),
            "downloadable": False,
            "needs_resolution": False,
        },
        "external_ids": {
            "rss_url": feed_url,
            "itunes_collection_id": itunes_id,
        },
    }


def build_podcast_recommendations(
    metadata: LibraryMetadata | None,
    limit: int = 24,
) -> dict[str, Any]:
    subs = []
    if metadata and isinstance(metadata.podcast_subscriptions, list):
        subs = [s for s in metadata.podcast_subscriptions if isinstance(s, dict)]
    items: list[dict[str, Any]] = []
    for idx, sub in enumerate(subs[:limit]):
        items.append(
            _podcast_item(
                sub,
                reason="A show you subscribe to.",
                reason_code="podcast_subscription",
                score=1.0 - idx * 0.02,
            )
        )
    return {
        "items": items,
        "sections": [
            {
                "id": "your_shows",
                "title": "Your Shows",
                "reason": "Podcast recommendations currently start from your subscriptions and listening history.",
                "item_ids": [item["id"] for item in items],
            }
        ],
        "settings": load_discovery_settings(),
    }
