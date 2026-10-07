"""Tests for resolution confidence scoring and YouTube resolution cache migration."""

import json
import tempfile
import pytest

from shared.resolution_confidence import (
    score_candidate,
    classify_confidence,
    best_candidate,
    CONFIDENCE_HIGH,
    CONFIDENCE_MEDIUM,
)
from shared.database import DatabaseManager


# ─── Scoring tests ───────────────────────────────────────────────────────────

def test_exact_title_artist_short_duration_delta_is_high():
    candidate = {"title": "Bohemian Rhapsody", "channel": "Queen", "duration": 354}
    score, reason = score_candidate("Queen", "Bohemian Rhapsody", 354, candidate)
    assert score >= CONFIDENCE_HIGH
    assert reason == "title_artist_duration"


def test_exact_title_artist_no_duration_is_medium_or_high():
    candidate = {"title": "Bohemian Rhapsody", "channel": "Queen", "duration": 0}
    score, reason = score_candidate("Queen", "Bohemian Rhapsody", None, candidate)
    assert score >= CONFIDENCE_MEDIUM
    assert "title_artist" in reason


def test_mismatched_title_is_low():
    candidate = {"title": "Something Completely Different", "channel": "Nobody", "duration": 200}
    score, _ = score_candidate("Queen", "Bohemian Rhapsody", 354, candidate)
    assert score < CONFIDENCE_MEDIUM


def test_title_only_match_when_channel_differs():
    candidate = {"title": "Bohemian Rhapsody", "channel": "SomeCoverBand", "duration": 354}
    score, reason = score_candidate("Queen", "Bohemian Rhapsody", 354, candidate)
    assert score >= CONFIDENCE_MEDIUM
    assert "title" in reason


def test_large_duration_delta_penalizes():
    # duration within 5s → higher score than duration off by > 30s
    candidate_close = {"title": "Bohemian Rhapsody", "channel": "Queen", "duration": 356}
    candidate_far = {"title": "Bohemian Rhapsody", "channel": "Queen", "duration": 90}
    score_close, _ = score_candidate("Queen", "Bohemian Rhapsody", 354, candidate_close)
    score_far, _ = score_candidate("Queen", "Bohemian Rhapsody", 354, candidate_far)
    assert score_close > score_far


def test_classify_confidence_thresholds():
    assert classify_confidence(0.90) == "high"
    assert classify_confidence(0.75) == "high"
    assert classify_confidence(0.74) == "medium"
    assert classify_confidence(0.40) == "medium"
    assert classify_confidence(0.39) == "low"
    assert classify_confidence(0.0) == "low"


def test_best_candidate_picks_highest_scorer():
    candidates = [
        {"id": "aaa", "title": "Wrong Song", "channel": "Nobody", "duration": 100},
        {"id": "bbb", "title": "Bohemian Rhapsody", "channel": "Queen", "duration": 354},
        {"id": "ccc", "title": "Bohemian Rhapsody (live)", "channel": "Queen", "duration": 360},
    ]
    best, score, reason, ranked = best_candidate("Queen", "Bohemian Rhapsody", 354, candidates)
    assert best["id"] == "bbb"
    assert score >= CONFIDENCE_HIGH
    assert ranked[0]["id"] == "bbb"
    assert all("confidence" in c for c in ranked)


def test_best_candidate_empty_returns_none():
    best, score, reason, ranked = best_candidate("Queen", "Bohemian Rhapsody", 354, [])
    assert best is None
    assert score == 0.0
    assert ranked == []


def test_best_candidate_caps_top_n():
    candidates = [{"id": str(i), "title": f"Track {i}", "channel": "X", "duration": 200} for i in range(10)]
    _, _, _, ranked = best_candidate("X", "Track 0", 200, candidates, top_n=3)
    assert len(ranked) <= 3


# ─── DB migration tests ──────────────────────────────────────────────────────

def _make_db():
    tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
    tmp.close()
    return DatabaseManager(tmp.name)


def test_new_columns_exist_after_init():
    db = _make_db()
    import sqlite3
    conn = sqlite3.connect(db.db_path)
    cursor = conn.execute("PRAGMA table_info(youtube_resolution_cache)")
    cols = {row[1] for row in cursor.fetchall()}
    conn.close()
    for col in ("confidence", "confidence_reason", "candidates_json", "failure_state", "verified_at"):
        assert col in cols, f"Missing column: {col}"


def test_set_and_get_cached_resolution_with_confidence():
    db = _make_db()
    candidates = [
        {"id": "vid1", "title": "Track", "channel": "Artist", "duration": 200, "confidence": 0.9}
    ]
    db.set_cached_resolution("Artist", "Track", {
        "id": "vid1",
        "duration": 200,
        "thumbnail": "http://example.com/thumb.jpg",
        "webpage_url": "https://youtube.com/watch?v=vid1",
        "channel": "Artist",
        "confidence": 0.9,
        "confidence_reason": "title_artist_duration",
        "candidates": candidates,
    })
    cached = db.get_cached_resolution("Artist", "Track")
    assert cached is not None
    assert cached["id"] == "vid1"
    assert cached["confidence"] == pytest.approx(0.9)
    assert cached["confidence_reason"] == "title_artist_duration"
    assert isinstance(cached["candidates"], list)
    assert len(cached["candidates"]) == 1


def test_set_cached_resolution_without_confidence_still_works():
    db = _make_db()
    db.set_cached_resolution("ArtistB", "TrackB", {
        "id": "vid2",
        "duration": 180,
        "thumbnail": "",
        "webpage_url": "",
        "channel": "ArtistB",
    })
    cached = db.get_cached_resolution("ArtistB", "TrackB")
    assert cached is not None
    assert cached["id"] == "vid2"
    assert cached["confidence"] is None
    assert cached["candidates"] == []


def test_upsert_updates_confidence():
    db = _make_db()
    db.set_cached_resolution("ArtistC", "TrackC", {
        "id": "old_vid", "confidence": 0.5, "confidence_reason": "title_only",
    })
    db.set_cached_resolution("ArtistC", "TrackC", {
        "id": "new_vid", "confidence": 0.88, "confidence_reason": "title_artist_duration",
    })
    cached = db.get_cached_resolution("ArtistC", "TrackC")
    assert cached["id"] == "new_vid"
    assert cached["confidence"] == pytest.approx(0.88)


# ─── Re-ranking a cached resolution ──────────────────────────────────────────

def _video_and_audio_cache() -> dict:
    """A resolution made without a running time: the music video, whose intro
    makes it 16 s longer than the album cut, beat the artist's audio upload."""
    candidates = [
        {"id": "video", "title": "Artist - Song", "channel": "Artist", "duration": 251},
        {"id": "audio", "title": "Artist - Song (Audio)", "channel": "ArtistVEVO", "duration": 236},
        {"id": "lyrics", "title": "Artist - Song (Lyrics)", "channel": "Some Fan", "duration": 236},
    ]
    return {"id": "video", "confidence": 0.67, "confidence_reason": "title_artist", "candidates": candidates}


def test_rerank_picks_the_cut_that_matches_a_running_time_the_cache_lacked():
    from shared.resolution_confidence import rerank_cached_resolution

    reranked = rerank_cached_resolution("Artist", "Song", 235, _video_and_audio_cache())
    assert reranked["id"] == "audio"
    assert reranked["confidence_reason"] == "title_artist_duration"
    assert classify_confidence(reranked["confidence"]) == "high"
    assert {c["id"] for c in reranked["candidates"]} == {"video", "audio", "lyrics"}


def test_rerank_changes_nothing_without_a_running_time():
    from shared.resolution_confidence import rerank_cached_resolution

    assert rerank_cached_resolution("Artist", "Song", None, _video_and_audio_cache()) is None


def test_rerank_rescores_a_winner_the_running_time_confirms():
    from shared.resolution_confidence import rerank_cached_resolution

    # The video stays the answer for its own 251 s, but now on duration evidence.
    reranked = rerank_cached_resolution("Artist", "Song", 251, _video_and_audio_cache())
    assert reranked["id"] == "video"
    assert reranked["confidence_reason"] == "title_artist_duration"
    assert reranked["confidence"] > 0.67
    # Asking again with the same time changes nothing more.
    assert rerank_cached_resolution("Artist", "Song", 251, {**_video_and_audio_cache(), **reranked}) is None


def test_rerank_leaves_a_winner_that_was_chosen_outside_the_candidates_alone():
    from shared.resolution_confidence import rerank_cached_resolution

    cached = {**_video_and_audio_cache(), "id": "picked-by-hand"}
    assert rerank_cached_resolution("Artist", "Song", 235, cached) is None


def test_cached_resolution_writes_the_correction_back():
    from shared.api.routes.catalog import cached_resolution

    db = _make_db()
    cached = _video_and_audio_cache()
    db.set_cached_resolution("Artist", "Song", cached)

    assert cached_resolution(db, "Artist", "Song", None)["id"] == "video"
    assert cached_resolution(db, "Artist", "Song", 235)["id"] == "audio"
    # Callers that know no running time now get the corrected answer too.
    stored = db.get_cached_resolution("Artist", "Song")
    assert stored["id"] == "audio" and stored["requested_duration"] == 235


def test_a_resolution_made_for_a_running_time_is_not_rewritten_by_another():
    from shared.api.routes.catalog import cached_resolution

    db = _make_db()
    # Resolved for the 251 s cut: the video is the right answer for that.
    db.set_cached_resolution("Artist", "Song", {**_video_and_audio_cache(), "requested_duration": 251})

    # A caller after the album cut gets the album cut...
    assert cached_resolution(db, "Artist", "Song", 235)["id"] == "audio"
    # ...without taking the stored answer away from everyone else.
    stored = db.get_cached_resolution("Artist", "Song")
    assert stored["id"] == "video" and stored["requested_duration"] == 251
