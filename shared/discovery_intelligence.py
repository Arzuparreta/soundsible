"""Local-first discovery settings, events, and deterministic recommendations."""

from __future__ import annotations

import json
import math
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

from shared import request_scope
from shared.models import LibraryMetadata, Track
from shared.database import user_db
from shared.telemetry import emit, user_telemetry_dir
from shared.user_context import user_config_dir

SETTINGS_VERSION = 1
DISCOVERY_PROFILE_POLICY_VERSION = "2"
_GENERATED_SOURCES = {"auto_mode", "autoplay", "radio"}
_PROFILE_POLICY_LOCK = threading.Lock()
DEFAULT_SETTINGS = {
    "v": SETTINGS_VERSION,
    "learning_enabled": True,
    "autoplay_enabled": True,
}

POSITIVE_LISTENING_EVENTS = {
    "music_played_30s",
    "music_saved_to_library",
    "music_favourited",
    "music_added_to_playlist",
    "music_added_to_queue",
    "music_started_radio",
    "music_generated_completed",
    "music_generated_skipped_early",
    "music_requested_from_dj",
    "podcast_episode_played_30s",
    "podcast_subscribed",
    "podcast_episode_saved",
}

_POSITIVE_WEIGHTS = {
    "music_played_30s": 1.0,
    "music_saved_to_library": 2.5,
    "music_favourited": 2.0,
    "music_added_to_playlist": 2.0,
    "music_added_to_queue": 0.35,
    "music_started_radio": 0.5,
    # A generated completion teaches the artist/neighbourhood rollup weakly,
    # never the exact identity multiplier that selected the song.
    "music_generated_completed": 0.0,
    "music_generated_skipped_early": 0.0,
    "music_requested_from_dj": 1.0,
    "podcast_episode_played_30s": 1.0,
    "podcast_subscribed": 2.5,
    "podcast_episode_saved": 2.0,
}

_NEGATIVE_WEIGHTS = {
    "music_generated_skipped_early": 0.15,
}


@dataclass
class ListeningRollup:
    """Aggregated signals from listening-events.jsonl."""
    artist_plays: dict[str, int] = field(default_factory=dict)
    artist_saves: dict[str, int] = field(default_factory=dict)
    album_plays: dict[str, int] = field(default_factory=dict)
    podcast_plays: dict[str, int] = field(default_factory=dict)
    played_track_ids: set[str] = field(default_factory=set)
    artist_affinity: dict[str, float] = field(default_factory=dict)
    track_affinity: dict[str, float] = field(default_factory=dict)
    recent_track_ids: list[str] = field(default_factory=list)
    recent_artists: list[str] = field(default_factory=list)
    event_count: int = 0
    last_event_ts: int = 0

    @property
    def has_data(self) -> bool:
        return bool(self.artist_plays or self.played_track_ids or self.podcast_plays)

    @property
    def saved_artists(self) -> list[str]:
        return sorted(self.artist_saves, key=lambda a: self.artist_saves[a], reverse=True)

    @property
    def maturity(self) -> str:
        if self.event_count >= 100 or len(self.played_track_ids) >= 40:
            return "established"
        if self.event_count >= 12 or len(self.played_track_ids) >= 6:
            return "warming"
        return "cold"


def _listening_events_paths() -> list[Path]:
    """Return candidate JSONL paths in newest-first order (base + up to 2 rotations).

    Listening history is per person, so this reads the bound user's telemetry
    directory — recommendations must never be built from somebody else's plays.
    """
    try:
        base = user_telemetry_dir() / "listening-events.jsonl"
    except Exception:
        return []
    paths = [base]
    for i in (1, 2):
        rot = base.parent / f"{base.name}.{i}"
        if rot.exists():
            paths.append(rot)
    return paths


def _event_deltas(
    event: str,
    payload: dict[str, Any],
    *,
    stored_positive: float = 0.0,
    stored_negative: float = 0.0,
) -> tuple[float, float]:
    source = _clean_str(payload.get("source"), 80).casefold()
    if event == "music_played_30s" and source in _GENERATED_SOURCES:
        return 0.0, 0.0
    if event in _POSITIVE_WEIGHTS:
        return float(_POSITIVE_WEIGHTS[event]), float(_NEGATIVE_WEIGHTS.get(event, 0.0))
    return max(0.0, stored_positive), max(0.0, stored_negative)


def ensure_discovery_profile_policy() -> None:
    """Rebuild stale aggregates from their audit rows once per account.

    The event log stays intact. Only derived deltas and aggregates change, so a
    generated 30-second play recorded by the old policy can no longer keep
    boosting the exact track or break a later undo.
    """
    with _PROFILE_POLICY_LOCK:
        db = user_db()
        if db.discovery_profile_policy_version() == DISCOVERY_PROFILE_POLICY_VERSION:
            return
        aggregates: dict[str, dict[str, Any]] = {}
        event_deltas: dict[str, tuple[float, float]] = {}
        for row in db.get_discovery_events():
            try:
                payload = json.loads(str(row.get("payload_json") or "{}"))
            except (TypeError, ValueError, json.JSONDecodeError):
                payload = {}
            if not isinstance(payload, dict):
                payload = {}
            positive, negative = _event_deltas(
                str(row.get("event") or ""),
                payload,
                stored_positive=float(row.get("positive_delta") or 0),
                stored_negative=float(row.get("negative_delta") or 0),
            )
            event_id = str(row.get("id") or "")
            if event_id:
                event_deltas[event_id] = (positive, negative)
            if row.get("undone_at") is not None:
                continue
            identity = str(row.get("identity") or "")
            if not identity:
                continue
            aggregate = aggregates.setdefault(identity, {
                "identity": identity,
                "media_type": str(row.get("media_type") or ""),
                "title": "",
                "artist": "",
                "show_title": "",
                "positive_weight": 0.0,
                "negative_weight": 0.0,
                "updated_at": 0,
            })
            aggregate["media_type"] = str(row.get("media_type") or aggregate["media_type"])
            aggregate["title"] = str(payload.get("title") or aggregate["title"])
            aggregate["artist"] = str(payload.get("artist") or aggregate["artist"])
            aggregate["show_title"] = str(payload.get("podcast_show_title") or aggregate["show_title"])
            aggregate["positive_weight"] += positive
            aggregate["negative_weight"] += negative
            aggregate["updated_at"] = max(
                int(aggregate["updated_at"]),
                int(row.get("created_at") or 0),
            )
        db.replace_discovery_signals(
            aggregates.values(),
            event_deltas,
            policy_version=DISCOVERY_PROFILE_POLICY_VERSION,
        )


def load_listening_event_rollups(max_events: int = 2000) -> ListeningRollup:
    """
    Read the tail of listening-events.jsonl and aggregate signals.
    Returns an empty rollup when learning is disabled or no events exist.

    Memoized per request: building one discovery feed asked for this five times,
    and each call re-read the event log and re-parsed up to `max_events` JSON
    objects. The result is treated as read-only by callers.
    """
    return request_scope.scoped(
        f"listening_rollup:{user_config_dir()}:{max_events}",
        lambda: _read_listening_event_rollups(max_events),
    )


def _read_listening_event_rollups(max_events: int = 2000) -> ListeningRollup:
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
    now = int(time.time())
    recent_tracks: list[str] = []
    recent_artists: list[str] = []
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
        try:
            event_ts = int(ev.get("ts") or now)
        except (TypeError, ValueError):
            event_ts = now
        age_days = max(0.0, (now - event_ts) / 86400)
        temporal_weight = math.pow(0.5, age_days / 45.0)
        positive_weight, _ = _event_deltas(event, ev)
        if event == "music_generated_completed":
            positive_weight = 0.15
        if positive_weight > 0:
            rollup.event_count += 1
            rollup.last_event_ts = max(rollup.last_event_ts, event_ts)
            if artist:
                rollup.artist_affinity[artist] = (
                    rollup.artist_affinity.get(artist, 0.0)
                    + positive_weight * temporal_weight
                )
            if track_id and event != "music_generated_completed":
                rollup.track_affinity[track_id] = (
                    rollup.track_affinity.get(track_id, 0.0)
                    + positive_weight * temporal_weight
                )

        generated_passive = (
            event == "music_played_30s"
            and _clean_str(ev.get("source"), 80).casefold() in _GENERATED_SOURCES
        )
        if event in ("music_played_30s", "music_search_played") and not generated_passive:
            if artist:
                rollup.artist_plays[artist] = rollup.artist_plays.get(artist, 0) + 1
            if artist and album:
                key = f"{artist}\x00{album}"
                rollup.album_plays[key] = rollup.album_plays.get(key, 0) + 1
            if track_id:
                rollup.played_track_ids.add(track_id)
                recent_tracks.append(track_id)
            if artist:
                recent_artists.append(artist)

        elif event == "music_saved_to_library":
            if artist:
                rollup.artist_saves[artist] = rollup.artist_saves.get(artist, 0) + 1

        elif event in ("podcast_episode_played_30s",):
            if feed_id:
                rollup.podcast_plays[feed_id] = rollup.podcast_plays.get(feed_id, 0) + 1

    rollup.recent_track_ids = list(dict.fromkeys(reversed(recent_tracks)))[:40]
    rollup.recent_artists = list(dict.fromkeys(reversed(recent_artists)))[:20]
    return rollup


def _settings_path() -> Path:
    return user_config_dir() / "discovery_settings.json"


def load_discovery_settings() -> dict[str, Any]:
    """Read this user's discovery settings, once per request.

    A single feed build called this about nineteen times, each one an
    `exists()` plus a read plus a `json.loads`.
    """
    return dict(request_scope.scoped(f"discovery_settings:{_settings_path()}", _read_discovery_settings))


def _read_discovery_settings() -> dict[str, Any]:
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
    if isinstance(data.get("autoplay_enabled"), bool):
        out["autoplay_enabled"] = data["autoplay_enabled"]
    return out


def save_discovery_settings(patch: dict[str, Any]) -> dict[str, Any]:
    current = load_discovery_settings()
    if "learning_enabled" in patch:
        current["learning_enabled"] = bool(patch["learning_enabled"])
    if "autoplay_enabled" in patch:
        current["autoplay_enabled"] = bool(patch["autoplay_enabled"])
    current["v"] = SETTINGS_VERSION
    path = _settings_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(current, indent=2, sort_keys=True), encoding="utf-8")
    # A request that saves settings and then reads them back must see the write,
    # and `learning_enabled` also gates the rollup.
    request_scope.invalidate("discovery_settings:")
    request_scope.invalidate("listening_rollup:")
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

    ensure_discovery_profile_policy()
    payload = payload if isinstance(payload, dict) else {}
    safe: dict[str, Any] = {
        "v": 2,
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
    identity, media_type = canonical_identity(safe)
    safe["identity"] = identity
    safe["media_type"] = media_type
    positive_delta, negative_delta = _event_deltas(event_name, safe)
    user_db().record_discovery_signal(
        event_id=str(uuid.uuid4()),
        event=event_name,
        identity=identity,
        media_type=media_type,
        positive_delta=positive_delta,
        negative_delta=negative_delta,
        payload=safe,
        created_at=int(safe["ts"]),
    )
    emit("listening-events", safe)
    # The rollup is memoized per request; a request that records an event and
    # then rebuilds a feed must see it.
    request_scope.invalidate("listening_rollup:")
    return True


def _norm(value: Any) -> str:
    return str(value or "").strip().lower()


def canonical_identity(payload: dict[str, Any]) -> tuple[str, str]:
    """Stable, local identity for one exact track, episode, or show."""
    media_type = _clean_str(payload.get("media_type"), 40)
    is_podcast = media_type.startswith("podcast") or bool(
        payload.get("podcast_feed_id")
        or payload.get("podcast_episode_id")
        or payload.get("itunes_collection_id")
    )
    if is_podcast:
        feed = _clean_str(
            payload.get("podcast_feed_id") or payload.get("itunes_collection_id"),
            400,
        )
        episode = _clean_str(payload.get("podcast_episode_id"), 400)
        if episode:
            return f"podcast:episode:{_norm(feed)}:{_norm(episode)}", "podcast_episode"
        if feed:
            return f"podcast:show:{_norm(feed)}", "podcast_show"
        return (
            f"podcast:show:{_norm(payload.get('podcast_show_title') or payload.get('title'))}",
            "podcast_show",
        )

    for key, prefix in (
        ("youtube_id", "music:youtube"),
        ("track_id", "music:track"),
        ("isrc", "music:isrc"),
        ("deezer_id", "music:deezer"),
    ):
        value = _clean_str(payload.get(key), 160)
        if value:
            return f"{prefix}:{_norm(value)}", "music_track"
    return (
        f"music:meta:{_norm(payload.get('artist'))}\x00{_norm(payload.get('title'))}",
        "music_track",
    )


def record_not_interested(payload: dict[str, Any]) -> str:
    """Record an explicit soft-negative signal and return its undo id."""
    if not load_discovery_settings().get("learning_enabled", True):
        return ""
    ensure_discovery_profile_policy()
    safe = {
        key: _clean_str(payload.get(key), 400)
        for key in (
            "media_type",
            "track_id",
            "title",
            "artist",
            "youtube_id",
            "deezer_id",
            "podcast_feed_id",
            "podcast_episode_id",
            "podcast_show_title",
            "itunes_collection_id",
            "source",
        )
        if payload.get(key) is not None
    }
    identity, media_type = canonical_identity(safe)
    event_id = str(uuid.uuid4())
    created_at = int(time.time())
    user_db().record_discovery_signal(
        event_id=event_id,
        event="not_interested",
        identity=identity,
        media_type=media_type,
        positive_delta=0,
        negative_delta=1,
        payload=safe,
        created_at=created_at,
    )
    emit("listening-events", {
        "v": 2,
        "event": "not_interested",
        "event_id": event_id,
        "identity": identity,
        "media_type": media_type,
        "ts": created_at,
        **safe,
    })
    request_scope.invalidate("listening_rollup:")
    return event_id


def undo_discovery_feedback(event_id: str) -> bool:
    return user_db().undo_discovery_signal(_clean_str(event_id, 80), int(time.time()))


def reset_discovery_profile() -> None:
    """Clear the bound account's aggregate, audit rows, and listening log."""
    request_scope.invalidate("listening_rollup:")
    user_db().clear_discovery_signals()
    for path in _listening_events_paths():
        try:
            path.unlink(missing_ok=True)
        except OSError:
            continue


def recommendation_multiplier(identity: str) -> float:
    """Soft learning multiplier. It can approach, but never reach, zero."""
    if not load_discovery_settings().get("learning_enabled", True):
        return 1.0
    ensure_discovery_profile_policy()
    signal = user_db().get_discovery_signals().get(identity)
    return _signal_multiplier(signal)


def _signal_multiplier(signal: dict[str, Any] | None) -> float:
    if not signal:
        return 1.0
    positive = max(0.0, float(signal.get("positive_weight") or 0))
    negatives = max(0.0, float(signal.get("negative_count") or 0))
    positive_factor = min(1.75, 1.0 + math.log1p(positive) * 0.18)
    negative_factor = max(0.08, math.exp(-0.72 * negatives))
    return positive_factor * negative_factor


def rank_recommendation_rows(
    rows: Iterable[dict[str, Any]],
    *,
    source: str,
) -> list[dict[str, Any]]:
    """Apply the shared profile to recommendation rows only.

    Every input row remains in the output. Learning changes probability/order;
    it never blacklists, filters, or affects explicit search/manual queues.
    """
    ranked: list[tuple[float, int, dict[str, Any]]] = []
    fallback_reasons = {
        "discover": ("Related to music in your library.", "library_graph"),
        "radio": ("Related to what you're playing.", "radio_related"),
        "auto_mode": ("Selected for Auto Mode.", "auto_mode_mix"),
        "autoplay": ("Similar to what you were listening to.", "autoplay_related"),
        "podcast": ("Recommended from your local podcast activity.", "podcast_activity"),
    }
    signals: dict[str, dict[str, Any]] = {}
    if load_discovery_settings().get("learning_enabled", True):
        ensure_discovery_profile_policy()
        signals = user_db().get_discovery_signals()
    for index, raw in enumerate(rows):
        row = dict(raw)
        identity = _clean_str(row.get("recommendation_identity"), 500)
        if not identity:
            identity_payload = dict(row)
            if (
                not identity_payload.get("youtube_id")
                and not str(identity_payload.get("media_type") or "").startswith("podcast")
            ):
                identity_payload["youtube_id"] = (
                    identity_payload.get("video_id") or identity_payload.get("id")
                )
            identity, _ = canonical_identity(identity_payload)
        base = float(row.get("score") or max(0.001, 1.0 - index * 0.01))
        row["recommendation_identity"] = identity
        row["recommendation_source"] = source
        fallback_reason, fallback_code = fallback_reasons.get(
            source,
            ("Recommended for you.", "local_recommendation"),
        )
        row["reason"] = _clean_str(row.get("reason")) or fallback_reason
        row["reason_code"] = _clean_str(row.get("reason_code"), 80) or fallback_code
        row["score"] = round(max(0.0001, base * _signal_multiplier(signals.get(identity))), 6)
        ranked.append((float(row["score"]), index, row))
    ranked.sort(key=lambda item: (-item[0], item[1]))
    return [row for _, _, row in ranked]


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
    external_ids = _external_ids_for_track(track)
    identity, _ = canonical_identity({
        "track_id": track.id,
        "youtube_id": external_ids.get("youtube_id"),
        "title": track.title,
        "artist": track.artist or track.album_artist,
    })
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
        "recommendation_identity": identity,
        "score": round(float(score), 4),
        "confidence": 1.0 if in_library else 0.65,
        "action_state": {
            "in_library": bool(in_library),
            "saved": bool(saved),
            "playable": True,
            "downloadable": not in_library,
            "needs_resolution": False,
        },
        "external_ids": external_ids,
    }


def _rollup_score_boost(artist_norm: str, rollup: ListeningRollup) -> float:
    """Extra score from listening history; capped at 0.50."""
    plays = rollup.artist_plays.get(artist_norm, 0)
    saves = rollup.artist_saves.get(artist_norm, 0)
    affinity = rollup.artist_affinity.get(artist_norm, 0.0)
    return min(0.50, math.log1p(affinity) * 0.12 + plays * 0.04 + saves * 0.08)


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
        "title_key": "rediscover",
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
                "title_key": "from_playlist",
                "title_params": {"playlist": pl_name},
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
                    "title_key": "cold_start",
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
            "title_key": "made_for_library",
            "reason": "Local-first picks from favourites, playlists, and library structure.",
            "item_ids": [item["id"] for item in items[:limit]],
        }
    ]

    rediscover = _build_rediscover_section(tracks, rollup)
    if rediscover:
        sections.append(rediscover)

    playlist_sections = _build_playlist_sections(tracks, by_id, playlists, rollup, seen, items)
    sections.extend(playlist_sections)

    ranked_items = rank_recommendation_rows(items, source="discover")
    return {
        "items": ranked_items[:limit],
        "sections": sections,
        "settings": load_discovery_settings(),
    }


def compose_discovery_feed(
    candidate_response: dict[str, Any],
    *,
    rollup: ListeningRollup | None = None,
    max_sections: int = 6,
    section_size: int = 12,
) -> dict[str, Any]:
    """Rank and diversify sections for the zero-query discovery feed.

    Candidate builders may propose many sections. The feed keeps only useful
    sections, removes duplicate tracks across them, and caps artist repetition.
    Queue planners and recommendation surfaces can consume the same ranked
    candidate foundation without coupling it to a particular UI.
    """
    if rollup is None:
        rollup = load_listening_event_rollups()

    raw_items = [
        dict(item)
        for item in candidate_response.get("items") or []
        if isinstance(item, dict) and item.get("id")
    ]
    item_by_id = {str(item["id"]): item for item in raw_items}
    candidates: list[tuple[float, int, dict[str, Any]]] = []

    for section_index, raw_section in enumerate(candidate_response.get("sections") or []):
        if not isinstance(raw_section, dict):
            continue
        section = dict(raw_section)
        ids = [
            str(item_id)
            for item_id in section.get("item_ids") or []
            if str(item_id) in item_by_id
        ]
        if not ids:
            continue

        ids.sort(key=lambda item_id: -float(item_by_id[item_id].get("score") or 0))
        artist_counts: dict[str, int] = {}
        diversified: list[str] = []
        for item_id in ids:
            item = item_by_id[item_id]
            artist = _norm(item.get("artist") or item.get("channel"))
            if artist and artist_counts.get(artist, 0) >= 2:
                continue
            diversified.append(item_id)
            if artist:
                artist_counts[artist] = artist_counts.get(artist, 0) + 1
            if len(diversified) >= section_size:
                break
        if not diversified:
            continue

        section_items = [item_by_id[item_id] for item_id in diversified]
        top_scores = [min(1.5, max(0.0, float(item.get("score") or 0))) for item in section_items[:4]]
        mean_score = sum(top_scores) / len(top_scores)
        novelty = sum(
            1 for item in section_items
            if not bool((item.get("action_state") or {}).get("in_library"))
        ) / len(section_items)
        confidence = sum(
            min(1.0, max(0.0, float(item.get("confidence") or 0.5)))
            for item in section_items
        ) / len(section_items)
        source_variety = min(
            1.0,
            len({_clean_str(item.get("source"), 80) for item in section_items if item.get("source")})
            / 3,
        )
        size_quality = min(1.0, len(section_items) / 8)
        utility = (
            mean_score * 0.55
            + novelty * 0.16
            + confidence * 0.13
            + source_variety * 0.08
            + size_quality * 0.08
        )
        section["item_ids"] = diversified
        section["section_type"] = section.get("section_type") or "track_rail"
        section["score"] = round(utility, 6)
        candidates.append((utility, section_index, section))

    candidates.sort(key=lambda row: (-row[0], row[1]))
    used_items: set[str] = set()
    sections: list[dict[str, Any]] = []
    for _, _, section in candidates:
        unique_ids = [item_id for item_id in section["item_ids"] if item_id not in used_items]
        if not unique_ids:
            continue
        section["item_ids"] = unique_ids
        used_items.update(unique_ids)
        sections.append(section)
        if len(sections) >= max_sections:
            break

    feed_items = [item_by_id[item_id] for section in sections for item_id in section["item_ids"]]
    return {
        "v": 1,
        "generated_at": int(time.time()),
        "items": feed_items,
        "sections": sections,
        "profile": {
            "maturity": rollup.maturity,
            "event_count": rollup.event_count,
            "distinct_tracks": len(rollup.played_track_ids),
            "learning_enabled": bool(
                candidate_response.get("settings", load_discovery_settings()).get(
                    "learning_enabled",
                    True,
                )
            ),
        },
        "needs_seed": not bool(sections),
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
    identity, _ = canonical_identity({
        "media_type": "podcast_show",
        "podcast_feed_id": feed_url,
        "itunes_collection_id": itunes_id,
        "podcast_show_title": row.get("title"),
    })
    return {
        "id": f"podcast:{_clean_str(stable, 160)}",
        "media_type": "podcast_show",
        "title": _clean_str(row.get("title"), 180) or "Podcast",
        "author": _clean_str(row.get("author"), 180),
        "image_url": _clean_str(row.get("image_url"), 400),
        "source": "subscription" if row.get("rss_url") else "itunes_podcast",
        "reason": reason,
        "reason_code": reason_code,
        "recommendation_identity": identity,
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
    exploration_rows: Iterable[dict[str, Any]] | None = None,
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

    subscribed_ids = {
        _clean_str(sub.get("itunes_collection_id") or sub.get("rss_url") or sub.get("feed_url"))
        for sub in subs
    }
    for index, row in enumerate(exploration_rows or []):
        if len(items) >= limit:
            break
        stable = _clean_str(
            row.get("itunes_collection_id") or row.get("feed_url") or row.get("rss_url")
        )
        if not stable or stable in subscribed_ids:
            continue
        subscribed_ids.add(stable)
        items.append(_podcast_item(
            row,
            reason="A little exploration beyond your subscriptions.",
            reason_code="podcast_exploration",
            score=max(0.15, 0.55 - index * 0.01),
        ))

    ranked_items = rank_recommendation_rows(items, source="podcast")
    return {
        "items": ranked_items,
        "sections": [
            {
                "id": "your_shows",
                "title": "Your Shows",
                "reason": "Subscriptions ranked by recent listening.",
                "item_ids": [item["id"] for item in ranked_items],
            }
        ],
        "settings": load_discovery_settings(),
    }
