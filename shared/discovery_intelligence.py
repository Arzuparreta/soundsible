"""Local-first discovery settings, events, and deterministic recommendations."""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

from shared.models import LibraryMetadata, Track
from shared.runtime import get_config_dir, get_runtime_config
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


@dataclass
class ListeningRollup:
    """Aggregated signals from listening-events.jsonl."""
    artist_plays: dict[str, int] = field(default_factory=dict)
    artist_saves: dict[str, int] = field(default_factory=dict)
    album_plays: dict[str, int] = field(default_factory=dict)
    podcast_plays: dict[str, int] = field(default_factory=dict)
    played_track_ids: set[str] = field(default_factory=set)

    @property
    def has_data(self) -> bool:
        return bool(self.artist_plays or self.played_track_ids or self.podcast_plays)

    @property
    def saved_artists(self) -> list[str]:
        return sorted(self.artist_saves, key=lambda a: self.artist_saves[a], reverse=True)


def _listening_events_paths() -> list[Path]:
    """Return candidate JSONL paths in newest-first order (base + up to 2 rotations)."""
    try:
        data_dir = get_runtime_config().data_dir
    except Exception:
        return []
    base = data_dir / "telemetry" / "listening-events.jsonl"
    paths = [base]
    for i in (1, 2):
        rot = base.parent / f"{base.name}.{i}"
        if rot.exists():
            paths.append(rot)
    return paths


def load_listening_event_rollups(max_events: int = 2000) -> ListeningRollup:
    """
    Read the tail of listening-events.jsonl and aggregate signals.
    Returns an empty rollup when learning is disabled or no events exist.
    """
    if not load_discovery_settings().get("learning_enabled", True):
        return ListeningRollup()

    lines: list[str] = []
    for path in _listening_events_paths():
        if not path.exists():
            continue
        try:
            with path.open("r", encoding="utf-8", errors="replace") as fh:
                lines.extend(fh.readlines())
        except Exception:
            continue
        if len(lines) >= max_events:
            break

    rollup = ListeningRollup()
    for raw in lines[-max_events:]:
        raw = raw.strip()
        if not raw:
            continue
        try:
            ev = json.loads(raw)
        except Exception:
            continue
        if not isinstance(ev, dict):
            continue
        event = ev.get("event") or ""
        artist = _norm(ev.get("artist"))
        album = _norm(ev.get("album"))
        track_id = _clean_str(ev.get("track_id") or "")
        feed_id = _clean_str(ev.get("podcast_feed_id") or ev.get("itunes_collection_id") or "")

        if event in ("music_played_30s", "music_search_played"):
            if artist:
                rollup.artist_plays[artist] = rollup.artist_plays.get(artist, 0) + 1
            if artist and album:
                key = f"{artist}\x00{album}"
                rollup.album_plays[key] = rollup.album_plays.get(key, 0) + 1
            if track_id:
                rollup.played_track_ids.add(track_id)

        elif event == "music_saved_to_library":
            if artist:
                rollup.artist_saves[artist] = rollup.artist_saves.get(artist, 0) + 1

        elif event in ("podcast_episode_played_30s",):
            if feed_id:
                rollup.podcast_plays[feed_id] = rollup.podcast_plays.get(feed_id, 0) + 1

    return rollup


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


def _rollup_score_boost(artist_norm: str, rollup: ListeningRollup) -> float:
    """Extra score from listening history; capped at 0.50."""
    plays = rollup.artist_plays.get(artist_norm, 0)
    saves = rollup.artist_saves.get(artist_norm, 0)
    return min(0.50, plays * 0.15 + saves * 0.20)


def _build_main_items(
    tracks: list[Track],
    by_id: dict[str, Track],
    fav_ids: list[str],
    fav_set: set[str],
    playlists: dict,
    rollup: ListeningRollup,
    limit: int,
) -> tuple[list[dict[str, Any]], set[str]]:
    """Build the primary recommendation items and a seen set."""
    items: list[dict[str, Any]] = []
    seen: set[str] = set()

    def add(track: Track, **kwargs: Any) -> None:
        if not track or track.id in seen or len(items) >= limit:
            return
        seen.add(track.id)
        items.append(_music_item(track, **kwargs))

    # Note: Favourites first
    for idx, tid in enumerate(fav_ids):
        track = by_id.get(tid)
        if track:
            artist_norm = _norm(track.album_artist or track.artist)
            boost = _rollup_score_boost(artist_norm, rollup)
            add(
                track,
                reason="A favourite in your library.",
                reason_code="library_favourite",
                score=min(1.0, 1.0 - idx * 0.01 + boost),
            )

    # Note: Playlist members
    playlist_members: dict[str, list[str]] = {}
    for name, ids in playlists.items():
        if isinstance(ids, list):
            playlist_members[str(name)] = [str(x) for x in ids if str(x) in by_id]
    for name, ids in sorted(playlist_members.items(), key=lambda kv: len(kv[1]), reverse=True):
        for idx, tid in enumerate(ids[:6]):
            track = by_id.get(tid)
            if track:
                artist_norm = _norm(track.album_artist or track.artist)
                boost = _rollup_score_boost(artist_norm, rollup)
                add(
                    track,
                    reason=f'From your playlist "{name}".',
                    reason_code="playlist_taste",
                    score=min(1.0, 0.9 - idx * 0.01 + boost),
                )

    # Note: Strong artists
    artist_counts: dict[str, int] = {}
    for track in tracks:
        artist = _norm(track.album_artist or track.artist)
        artist_counts[artist] = artist_counts.get(artist, 0) + 1
    strong_artists = {artist for artist, count in artist_counts.items() if artist and count >= 2}
    for track in tracks:
        artist_norm = _norm(track.album_artist or track.artist)
        if artist_norm in strong_artists:
            boost = _rollup_score_boost(artist_norm, rollup)
            add(
                track,
                reason=f"You have several tracks by {track.album_artist or track.artist}.",
                reason_code="artist_affinity",
                score=min(1.0, 0.78 + boost),
            )

    # Note: Recent tracks
    sorted_recent = sorted(tracks, key=lambda t: _clean_str(getattr(t, "id", "")), reverse=True)
    for track in sorted_recent:
        artist_norm = _norm(track.album_artist or track.artist)
        boost = _rollup_score_boost(artist_norm, rollup)
        add(
            track,
            reason="Ready from your local library.",
            reason_code="library_owned",
            score=min(1.0, (0.62 if track.id not in fav_set else 0.7) + boost),
        )

    return items, seen


def _build_rediscover_section(tracks: list[Track], rollup: ListeningRollup) -> dict[str, Any] | None:
    if not rollup.played_track_ids or len(rollup.played_track_ids) < 3:
        return None
    rediscover_ids: list[str] = []
    rediscover_dedup: set[str] = set()
    for track in tracks:
        if len(rediscover_ids) >= 12:
            break
        if track.id not in rollup.played_track_ids and track.id not in rediscover_dedup:
            rediscover_dedup.add(track.id)
            rediscover_ids.append(f"music:{track.id}")
    if not rediscover_ids:
        return None
    return {
        "id": "rediscover",
        "title": "Rediscover",
        "reason": "Tracks in your library you haven't played in a while.",
        "item_ids": rediscover_ids,
    }


def _build_playlist_sections(
    tracks: list[Track],
    by_id: dict[str, Track],
    playlists: dict,
    rollup: ListeningRollup,
    seen: set[str],
    items: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    playlist_members: dict[str, list[str]] = {}
    for name, ids in playlists.items():
        if isinstance(ids, list):
            playlist_members[str(name)] = [str(x) for x in ids if str(x) in by_id]
    if not playlist_members:
        return []

    sorted_playlists = sorted(
        [(name, ids) for name, ids in playlist_members.items() if ids],
        key=lambda kv: len(kv[1]),
        reverse=True,
    )
    sections: list[dict[str, Any]] = []
    for pl_name, pl_ids in sorted_playlists[:3]:
        pl_item_ids: list[str] = []
        pl_dedup: set[str] = set()
        for tid in pl_ids[:8]:
            if tid not in pl_dedup:
                pl_dedup.add(tid)
                pl_item_ids.append(f"music:{tid}")
                track = by_id.get(tid)
                if track and track.id not in seen:
                    seen.add(track.id)
                    artist_norm = _norm(track.album_artist or track.artist)
                    boost = _rollup_score_boost(artist_norm, rollup)
                    items.append(_music_item(
                        track,
                        reason=f'From your playlist "{pl_name}".',
                        reason_code="playlist_taste",
                        score=min(1.0, 0.85 + boost),
                    ))
        if pl_item_ids:
            sections.append({
                "id": f"from_playlist_{_norm(pl_name)[:40].replace(' ', '_')}",
                "title": pl_name,
                "reason": f"Tracks from your playlist.",
                "item_ids": pl_item_ids,
                "playlist_name": pl_name,
                "section_type": "from_your_playlists",
            })
    return sections


def build_music_recommendations(
    metadata: LibraryMetadata | None,
    favourite_ids: Iterable[str] | None = None,
    limit: int = 24,
    rollup: ListeningRollup | None = None,
) -> dict[str, Any]:
    if rollup is None:
        rollup = load_listening_event_rollups()

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
    items, seen = _build_main_items(tracks, by_id, fav_ids, fav_set, playlists, rollup, limit)

    sections: list[dict[str, Any]] = [
        {
            "id": "made_for_your_library",
            "title": "Made for Your Library",
            "reason": "Local-first picks from favourites, playlists, and library structure.",
            "item_ids": [item["id"] for item in items[:limit]],
        }
    ]

    rediscover = _build_rediscover_section(tracks, rollup)
    if rediscover:
        sections.append(rediscover)

    playlist_sections = _build_playlist_sections(tracks, by_id, playlists, rollup, seen, items)
    sections.extend(playlist_sections)

    return {
        "items": items[:limit],
        "sections": sections,
        "settings": load_discovery_settings(),
    }


def load_recently_saved_tracks(limit: int = 12) -> list[dict[str, Any]]:
    """
    Return the last `limit` unique tracks saved to the library, newest first.
    Reads music_saved_to_library events from listening-events.jsonl.
    Returns a list of dicts with track_id, title, artist, deezer_id, youtube_id.
    """
    if not load_discovery_settings().get("learning_enabled", True):
        return []

    lines: list[str] = []
    for path in _listening_events_paths():
        if not path.exists():
            continue
        try:
            with path.open("r", encoding="utf-8", errors="replace") as fh:
                lines.extend(fh.readlines())
        except Exception:
            continue

    seen_ids: set[str] = set()
    result: list[dict[str, Any]] = []
    for raw in reversed(lines):
        raw = raw.strip()
        if not raw:
            continue
        try:
            ev = json.loads(raw)
        except Exception:
            continue
        if not isinstance(ev, dict) or ev.get("event") != "music_saved_to_library":
            continue
        tid = _clean_str(ev.get("track_id") or "")
        if not tid or tid in seen_ids:
            continue
        seen_ids.add(tid)
        result.append({
            "track_id": tid,
            "title": _clean_str(ev.get("title") or ""),
            "artist": _clean_str(ev.get("artist") or ""),
            "deezer_id": _clean_str(ev.get("deezer_id") or ""),
            "youtube_id": _clean_str(ev.get("youtube_id") or ev.get("video_id") or ""),
            "saved_at": ev.get("ts") or 0,
        })
        if len(result) >= limit:
            break
    return result


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
    rollup: ListeningRollup | None = None,
) -> dict[str, Any]:
    if rollup is None:
        rollup = load_listening_event_rollups()

    subs = []
    if metadata and isinstance(metadata.podcast_subscriptions, list):
        subs = [s for s in metadata.podcast_subscriptions if isinstance(s, dict)]

    def _podcast_plays_for(sub: dict) -> int:
        for key in (
            _clean_str(sub.get("rss_url") or ""),
            _clean_str(sub.get("feed_url") or ""),
            _clean_str(sub.get("itunes_collection_id") or ""),
        ):
            if key and key in rollup.podcast_plays:
                return rollup.podcast_plays[key]
        return 0

    def _podcast_score(sub: dict, base: float) -> float:
        plays = _podcast_plays_for(sub)
        return min(1.0, base + plays * 0.15)

    items: list[dict[str, Any]] = []
    scored_subs = sorted(
        enumerate(subs[:limit]),
        key=lambda iv: _podcast_score(iv[1], 1.0 - iv[0] * 0.02),
        reverse=True,
    )
    for _, sub in scored_subs:
        idx = subs.index(sub)
        score = _podcast_score(sub, 1.0 - idx * 0.02)
        plays = _podcast_plays_for(sub)
        reason = "A show you've been listening to." if plays > 0 else "A show you subscribe to."
        items.append(
            _podcast_item(
                sub,
                reason=reason,
                reason_code="podcast_recently_played" if plays > 0 else "podcast_subscription",
                score=score,
            )
        )

    return {
        "items": items,
        "sections": [
            {
                "id": "your_shows",
                "title": "Your Shows",
                "reason": "Subscriptions ranked by recent listening.",
                "item_ids": [item["id"] for item in items],
            }
        ],
        "settings": load_discovery_settings(),
    }
