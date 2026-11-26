"""Derived multi-horizon artist taste profile built from real listening and library priors."""

from __future__ import annotations

from dataclasses import dataclass
import json
import math
import time
import unicodedata
from typing import Any, Iterable

from shared import request_scope
from shared.database import instance_db, user_db
from shared.deezer_catalog import literal_artist_key
from shared.discovery_intelligence import (
    is_artist_demoted,
    load_discovery_settings,
)
from shared.text_utils import fold_text
from shared.user_context import current_user_id, user_config_dir, user_context

_GENERATED_SOURCES = frozenset({"auto_mode", "autoplay", "radio"})
_SUBSONIC_SOURCES = frozenset({"subsonic"})
_LIBRARY_SKIP_SOURCES = frozenset({"library", "playlist", "album", "artist", "favourites"})

_DAILY_CAP = 2.5
_SHORT_HALF_LIFE_DAYS = 14.0
_LONG_HALF_LIFE_DAYS = 120.0
_PRIOR_CAP = 6.0
_MIN_RELEASE_EFFECTIVE_SCORE = 0.25


@dataclass(frozen=True)
class ArtistProfileEntry:
    """Aggregated taste metrics for one artist in the current user's profile."""

    artist_key: str
    literal_key: str
    display_name: str
    deezer_artist_id: str
    short_term_score: float
    long_term_score: float
    library_prior: float
    effective_score: float
    distinct_days: int
    distinct_tracks: int
    active_plays: float
    passive_plays: float
    early_skips: float
    last_listened_at: int
    updated_at: int


def _load_profile_inputs() -> tuple[list[dict[str, Any]], dict[str, dict[str, Any]]]:
    """Load per-user audit events and track play counts once per request scope."""

    def read() -> tuple[list[dict[str, Any]], dict[str, dict[str, Any]]]:
        db = user_db()
        try:
            events = db.get_discovery_events()
        except Exception:
            events = []
        try:
            track_states = db.get_all_track_user_states()
        except Exception:
            track_states = {}
        return events, track_states

    return request_scope.scoped(f"discovery_artist_profile:{user_config_dir()}", read)


def _known_deezer_artist_ids(user_id: str | None) -> dict[str, str]:
    """Best-effort Deezer ID lookup for negative-feedback checks only (never adds positive score)."""
    mapping: dict[str, str] = {}
    try:
        from player.saved_entities import get_entries

        entries = get_entries()
        for entry in entries:
            if not isinstance(entry, dict) or entry.get("kind") != "artist":
                continue
            name = str(entry.get("name") or "").strip()
            lit = literal_artist_key(name)
            if not lit:
                continue
            for key in entry.get("keys") or ():
                if isinstance(key, str) and key.startswith("artist:deezer:"):
                    candidate = key[len("artist:deezer:"):].strip()
                    if candidate.isdigit():
                        mapping.setdefault(lit, candidate)
                        break
    except Exception:
        pass
    return mapping


def _intent_weight(source: str) -> float:
    if source in _GENERATED_SOURCES:
        return 0.30
    if source in _SUBSONIC_SOURCES:
        return 0.90
    return 1.00


def _coalesce_session_event(
    event: str,
    payload: dict[str, Any],
) -> tuple[float, float, str, bool]:
    """Return ``(positive_value, skip_penalty, source_kind, is_play_session)`` for one audit event."""
    source = str(payload.get("source") or "").strip().casefold()
    intent = _intent_weight(source)
    if event == "music_play_completed":
        if source in _GENERATED_SOURCES:
            return 1.0 * 0.30, 0.0, "passive", True
        return 1.15 * intent, 0.0, "active", True
    if event == "music_generated_completed":
        return 1.0 * 0.30, 0.0, "passive", True
    if event == "music_played_30s":
        kind = "passive" if source in _GENERATED_SOURCES else "active"
        return 0.75 * intent, 0.0, kind, True
    if event in ("music_play_skipped_early", "music_generated_skipped_early"):
        if source in _LIBRARY_SKIP_SOURCES:
            return 0.0, 0.0, "skip", False
        return 0.0, 1.0, "skip", False
    if event == "music_saved_to_library":
        return 1.20, 0.0, "active", True
    if event in ("music_favourited", "music_added_to_playlist", "music_requested_from_dj"):
        return 1.00, 0.0, "active", False
    if event == "music_started_radio":
        return 0.60, 0.0, "active", False
    if event == "music_added_to_queue":
        return 0.40, 0.0, "active", False
    return 0.0, 0.0, "ignored", False


def build_artist_taste_profile(
    metadata,
    fav_ids: Iterable[str] | None = None,
    *,
    user_id: str | None = None,
    persist: bool = True,
    now: int | None = None,
) -> list[ArtistProfileEntry]:
    """Compute and optionally persist the listener's multi-horizon artist profile.

    Pins/bookmarks contribute **zero** positive weight.
    """
    if user_id is not None and user_id != current_user_id():
        with user_context(user_id):
            return build_artist_taste_profile(
                metadata,
                fav_ids,
                user_id=None,
                persist=persist,
                now=now,
            )

    now_ts = int(now if now is not None else time.time())
    learning_enabled = bool(load_discovery_settings().get("learning_enabled", True))
    tracks = list(metadata.tracks if metadata and metadata.tracks else [])
    music_tracks = [t for t in tracks if getattr(t, "media_kind", None) != "podcast_episode"]
    by_id = {t.id: t for t in music_tracks}
    fav_list = [str(tid) for tid in (fav_ids or []) if tid]

    variant_scores: dict[str, dict[str, float]] = {}
    variant_display: dict[str, dict[str, str]] = {}
    deezer_ids_by_literal: dict[str, str] = {}
    persisted_ids: dict[tuple[str, str], str] = {}
    if learning_enabled:
        try:
            for row in user_db().get_discovery_artist_profile():
                did = str(row.get("deezer_artist_id") or "").strip()
                ak = str(row.get("artist_key") or "").strip()
                lk = str(row.get("literal_key") or "").strip()
                if ak and lk and did.isdigit():
                    persisted_ids[(ak, lk)] = did
        except Exception:
            pass

    def record_variant(
        raw_name: object,
        score_hint: float = 0.0,
        *,
        deezer_artist_id: str = "",
    ) -> tuple[str, str]:
        name = str(raw_name or "").strip()
        key = fold_text(name)
        lit = literal_artist_key(name)
        if not key or not lit:
            return "", ""
        v_disp = variant_display.setdefault(key, {})
        if lit not in v_disp:
            v_disp[lit] = name
        if score_hint:
            v_scores = variant_scores.setdefault(key, {})
            v_scores[lit] = v_scores.get(lit, 0.0) + score_hint
        if deezer_artist_id and deezer_artist_id.isdigit():
            deezer_ids_by_literal.setdefault(lit, deezer_artist_id)
        return key, lit

    # Session-coalesced positive listens per artist
    # session_key -> {artist_key, ts, pos_val, skip_val, kind, track_ident, is_play_session}
    sessions: dict[str, dict[str, Any]] = {}
    event_track_ids: set[str] = set()
    active_plays: dict[str, float] = {}
    passive_plays: dict[str, float] = {}
    early_skips: dict[str, float] = {}
    last_listened_at: dict[str, int] = {}

    if learning_enabled:
        events, track_states = _load_profile_inputs()
        for row in events:
            if row.get("undone_at") is not None:
                continue
            event_name = str(row.get("event") or "").strip()
            if not event_name or event_name.startswith("podcast_") or event_name in (
                "not_interested",
                "less_from_artist",
                "music_search_played",
            ):
                continue
            media_type = str(row.get("media_type") or "")
            if media_type.startswith("podcast"):
                continue
            try:
                payload = json.loads(str(row.get("payload_json") or "{}"))
            except (TypeError, ValueError, json.JSONDecodeError):
                payload = {}
            if not isinstance(payload, dict):
                payload = {}

            artist_raw = payload.get("artist")
            if isinstance(artist_raw, dict):
                artist_name = str(artist_raw.get("name") or "").strip()
                daid = str(artist_raw.get("id") or payload.get("deezer_artist_id") or "").strip()
            else:
                artist_name = str(artist_raw or "").strip()
                daid = str(payload.get("deezer_artist_id") or "").strip()
            if not artist_name:
                continue

            pos_val, skip_val, kind, is_play_session = _coalesce_session_event(event_name, payload)
            if pos_val <= 0 and skip_val <= 0:
                continue

            artist_key, _ = record_variant(artist_name, max(pos_val, 0.01), deezer_artist_id=daid)
            if not artist_key:
                continue

            ts = int(row.get("created_at") or now_ts)
            track_id = str(payload.get("track_id") or "").strip()
            if track_id and pos_val > 0:
                event_track_ids.add(track_id)

            track_ident = str(
                track_id
                or payload.get("youtube_id")
                or payload.get("deezer_id")
                or payload.get("isrc")
                or fold_text(payload.get("title"))
                or ""
            ).strip()
            play_session_id = str(payload.get("play_session_id") or "").strip()
            if play_session_id and event_name in (
                "music_played_30s",
                "music_play_completed",
                "music_generated_completed",
                "music_play_skipped_early",
                "music_generated_skipped_early",
            ):
                s_key = f"{artist_key}\x00session:{play_session_id}"
            else:
                s_key = f"{artist_key}\x00event:{row.get('id') or len(sessions)}"

            existing = sessions.get(s_key)
            if existing is None:
                sessions[s_key] = {
                    "artist_key": artist_key,
                    "ts": ts,
                    "pos_val": pos_val,
                    "skip_val": skip_val,
                    "kind": kind,
                    "track_ident": track_ident,
                    "is_play_session": is_play_session,
                }
            else:
                existing["ts"] = max(existing["ts"], ts)
                if pos_val > existing["pos_val"]:
                    existing["pos_val"] = pos_val
                    existing["kind"] = kind
                if skip_val > existing["skip_val"] and existing["pos_val"] <= 0:
                    existing["skip_val"] = skip_val
                existing["is_play_session"] = existing["is_play_session"] or is_play_session

        # Fold legacy track_user_state play counts for library tracks absent from discovery_events
        for tid, st in track_states.items():
            if tid in event_track_ids:
                continue
            plays = int(st.get("play_count") or 0)
            if plays <= 0:
                continue
            track = by_id.get(tid)
            if not track:
                continue
            artist_name = str(track.album_artist or track.artist or "").strip()
            if not artist_name:
                continue
            ts = int(st.get("last_played_at") or (now_ts - 30 * 86400))
            capped_plays = min(plays, 5)
            val = capped_plays * 0.60
            artist_key, _ = record_variant(artist_name, val)
            if not artist_key:
                continue
            sessions[f"{artist_key}\x00legacy:{tid}"] = {
                "artist_key": artist_key,
                "ts": ts,
                "pos_val": val,
                "skip_val": 0.0,
                "kind": "active",
                "track_ident": tid,
                "is_play_session": True,
                "play_count_weight": float(capped_plays),
            }

    # Aggregate daily buckets, distinct days, distinct tracks, and session totals
    daily_sums: dict[str, dict[int, float]] = {}
    daily_latest_ts: dict[str, dict[int, int]] = {}
    distinct_days_map: dict[str, set[int]] = {}
    distinct_tracks_map: dict[str, set[str]] = {}
    total_positive_sessions = 0

    for sess in sessions.values():
        artist_key = sess["artist_key"]
        pos_val = float(sess["pos_val"])
        skip_val = float(sess["skip_val"])
        ts = int(sess["ts"])
        if pos_val > 0:
            day_bucket = ts // 86400
            day_map = daily_sums.setdefault(artist_key, {})
            day_map[day_bucket] = day_map.get(day_bucket, 0.0) + pos_val
            ts_map = daily_latest_ts.setdefault(artist_key, {})
            ts_map[day_bucket] = max(ts_map.get(day_bucket, 0), ts)
            distinct_days_map.setdefault(artist_key, set()).add(day_bucket)
            if sess["track_ident"]:
                distinct_tracks_map.setdefault(artist_key, set()).add(sess["track_ident"])
            last_listened_at[artist_key] = max(last_listened_at.get(artist_key, 0), ts)
            if sess["is_play_session"]:
                total_positive_sessions += 1
            count_w = float(sess.get("play_count_weight", 1.0))
            if sess["kind"] == "passive":
                passive_plays[artist_key] = passive_plays.get(artist_key, 0.0) + count_w
            else:
                active_plays[artist_key] = active_plays.get(artist_key, 0.0) + count_w
        elif skip_val > 0:
            early_skips[artist_key] = early_skips.get(artist_key, 0.0) + skip_val

    # Library / favourites / playlists priors (log-saturated, zero pins)
    fav_counts: dict[str, int] = {}
    playlist_counts: dict[str, int] = {}
    lib_counts: dict[str, int] = {}

    for tid in fav_list:
        track = by_id.get(tid)
        if not track:
            continue
        artist_name = str(track.album_artist or track.artist or "").strip()
        artist_key, _ = record_variant(artist_name, 3.0)
        if artist_key:
            fav_counts[artist_key] = fav_counts.get(artist_key, 0) + 1

    playlists = metadata.playlists if metadata and isinstance(metadata.playlists, dict) else {}
    playlist_track_ids: set[str] = set()
    for ids in playlists.values():
        if isinstance(ids, list):
            playlist_track_ids.update(str(x) for x in ids)
    for tid in playlist_track_ids:
        track = by_id.get(tid)
        if not track:
            continue
        artist_name = str(track.album_artist or track.artist or "").strip()
        artist_key, _ = record_variant(artist_name, 1.5)
        if artist_key:
            playlist_counts[artist_key] = playlist_counts.get(artist_key, 0) + 1

    for track in music_tracks:
        artist_name = str(track.album_artist or track.artist or "").strip()
        artist_key, _ = record_variant(artist_name, 0.5)
        if artist_key:
            lib_counts[artist_key] = lib_counts.get(artist_key, 0) + 1

    if total_positive_sessions >= 100:
        gamma = 0.20
    elif total_positive_sessions >= 12:
        gamma = 0.50
    else:
        gamma = 1.00

    # Extra Deezer ID lookup strictly for negative-feedback matching (never positive score)
    negative_id_lookup = _known_deezer_artist_ids(user_id)
    try:
        inst = instance_db()
    except Exception:
        inst = None

    all_keys = set(daily_sums) | set(fav_counts) | set(playlist_counts) | set(lib_counts) | set(early_skips)
    entries: list[ArtistProfileEntry] = []

    for artist_key in all_keys:
        key_nfc = unicodedata.normalize("NFC", artist_key)
        v_scores = variant_scores.get(artist_key, {})
        v_disp = variant_display.get(artist_key, {})
        if v_scores:
            best_lit = max(v_scores, key=lambda lit: (v_scores[lit], lit != key_nfc))
            display_name = v_disp.get(best_lit, best_lit)
        elif v_disp:
            best_lit = next(iter(v_disp))
            display_name = v_disp[best_lit]
        else:
            continue

        deezer_id = deezer_ids_by_literal.get(best_lit, "")
        if not deezer_id and inst is not None:
            try:
                node = inst.find_graph_node_by_literal(best_lit)
                if node:
                    deezer_id = str(node.get("deezer_artist_id") or "")
            except Exception:
                pass
        if not deezer_id:
            deezer_id = persisted_ids.get((artist_key, best_lit), "")
        exclusion_deezer_id = deezer_id or negative_id_lookup.get(best_lit, "")
        if is_artist_demoted(display_name, deezer_artist_id=exclusion_deezer_id):
            continue

        s_short = 0.0
        s_long = 0.0
        day_ts_map = daily_latest_ts.get(artist_key, {})
        for day_bucket, raw_sum in daily_sums.get(artist_key, {}).items():
            capped = min(raw_sum, _DAILY_CAP)
            ref_ts = day_ts_map.get(day_bucket, day_bucket * 86400)
            age_days = max(0.0, (now_ts - ref_ts) / 86400.0)
            s_short += capped * math.pow(0.5, age_days / _SHORT_HALF_LIFE_DAYS)
            s_long += capped * math.pow(0.5, age_days / _LONG_HALF_LIFE_DAYS)

        n_days = len(distinct_days_map.get(artist_key, ()))
        n_tracks = len(distinct_tracks_map.get(artist_key, ()))
        breadth = 1.0 + 0.18 * math.log1p(n_days) + 0.12 * math.log1p(n_tracks)
        h_short = s_short * breadth
        h_long = s_long * breadth

        prior = min(
            _PRIOR_CAP,
            1.6 * math.log1p(fav_counts.get(artist_key, 0))
            + 0.9 * math.log1p(playlist_counts.get(artist_key, 0))
            + 0.5 * math.log1p(lib_counts.get(artist_key, 0)),
        )
        skips = early_skips.get(artist_key, 0.0)
        effective = max(0.0, 0.45 * h_short + 0.55 * h_long + gamma * prior - 0.15 * skips)
        if effective <= 0.0:
            continue

        entries.append(
            ArtistProfileEntry(
                artist_key=artist_key,
                literal_key=best_lit,
                display_name=display_name,
                deezer_artist_id=deezer_id,
                short_term_score=round(h_short, 6),
                long_term_score=round(h_long, 6),
                library_prior=round(prior, 6),
                effective_score=round(effective, 6),
                distinct_days=n_days,
                distinct_tracks=n_tracks,
                active_plays=round(active_plays.get(artist_key, 0.0), 3),
                passive_plays=round(passive_plays.get(artist_key, 0.0), 3),
                early_skips=round(skips, 3),
                last_listened_at=last_listened_at.get(artist_key, 0),
                updated_at=now_ts,
            )
        )

    entries.sort(key=lambda e: (-e.effective_score, -e.last_listened_at, e.artist_key))
    if persist and learning_enabled:
        try:
            user_db().replace_discovery_artist_profile(
                [
                    {
                        "artist_key": e.artist_key,
                        "literal_key": e.literal_key,
                        "display_name": e.display_name,
                        "deezer_artist_id": e.deezer_artist_id,
                        "short_term_score": e.short_term_score,
                        "long_term_score": e.long_term_score,
                        "library_prior": e.library_prior,
                        "effective_score": e.effective_score,
                        "distinct_days": e.distinct_days,
                        "distinct_tracks": e.distinct_tracks,
                        "active_plays": e.active_plays,
                        "passive_plays": e.passive_plays,
                        "early_skips": e.early_skips,
                        "last_listened_at": e.last_listened_at,
                        "updated_at": e.updated_at,
                    }
                    for e in entries
                ]
            )
        except Exception:
            pass
    return entries


def select_release_profile_artists(
    profile: list[ArtistProfileEntry],
    *,
    limit: int = 35,
    min_score: float = _MIN_RELEASE_EFFECTIVE_SCORE,
) -> list[ArtistProfileEntry]:
    """Select the union of strong long-term and short-term artists for Home New Releases."""
    eligible = [e for e in profile if e.effective_score >= min_score]
    if not eligible:
        return []
    by_long = sorted(eligible, key=lambda e: (-e.long_term_score, -e.effective_score, e.artist_key))
    by_short = sorted(eligible, key=lambda e: (-e.short_term_score, -e.effective_score, e.artist_key))
    selected: list[ArtistProfileEntry] = []
    seen: set[str] = set()
    # Interleave core long-term, active short-term, and overall effective score
    for pair in zip(by_long, by_short, eligible):
        for entry in pair:
            if entry.artist_key in seen:
                continue
            seen.add(entry.artist_key)
            selected.append(entry)
            if len(selected) >= limit:
                return selected
    for entry in eligible:
        if entry.artist_key in seen:
            continue
        seen.add(entry.artist_key)
        selected.append(entry)
        if len(selected) >= limit:
            break
    return selected
