import threading
import math
import struct
import time
import wave

import pytest

from shared.dj_engine import (
    analyse_audio,
    cached_analysis,
    order_route,
    plan_transition,
    request_analysis,
    route_to_request,
)


def analysis(*, bpm=120, key="C", mode="major", energy=0.5, confidence=0.9, duration=240):
    return {
        "bpm": bpm,
        "key": key,
        "mode": mode,
        "energy": energy,
        "confidence": confidence,
        "duration": duration,
        "outro_cue": duration - 8,
        "intro_cue": 8,
        "bar_seconds": 2,
    }


def item(identity, score=0.5):
    return {
        "id": identity,
        "title": identity,
        "artist": "Artist",
        "recommendation_identity": identity,
        "score": score,
    }


def test_transition_uses_phrase_runway_instead_of_running_past_the_file():
    transition = plan_transition(
        analysis(duration=180),
        analysis(bpm=121, key="G"),
        profile="long_blend",
    )
    assert transition["technique"] == "long_blend"
    assert transition["out_cue"] + transition["overlap_seconds"] <= 180
    assert 0.94 <= transition["playback_rate"] <= 1.06


def test_local_grid_rate_moves_the_incoming_tempo_in_the_right_direction():
    transition = plan_transition(
        analysis(bpm=120, key="C"),
        analysis(bpm=125, key="G"),
        profile="long_blend",
    )
    assert transition["playback_rate"] == pytest.approx(0.96, abs=0.01)


def test_incompatible_pair_gets_a_structural_fallback():
    transition = plan_transition(
        analysis(bpm=72, key="C", confidence=0.6),
        analysis(bpm=137, key="F#", confidence=0.6),
        profile="adaptive",
    )
    assert transition["fallback"] is True
    assert transition["technique"] in {"echo_cut", "structural_fade", "safe_fade"}


def test_request_is_eventually_reached_while_a_clean_direct_mix_stays_preferred():
    current = analysis(bpm=100, key="C")
    bridges = [
        (item("bridge-a"), analysis(bpm=112, key="G")),
        (item("bridge-b"), analysis(bpm=124, key="D")),
        (item("bridge-c"), analysis(bpm=128, key="F#")),
    ]
    requested = (item("requested"), analysis(bpm=128, key="D"))
    route = route_to_request(current, bridges, requested, profile="adaptive", max_starts=5)
    assert 1 <= len(route) <= 5
    assert route[-1]["id"] == "requested"

    direct = route_to_request(
        analysis(bpm=128, key="D"),
        bridges,
        requested,
        profile="adaptive",
        max_starts=5,
    )
    assert [row["id"] for row in direct] == ["requested"]


def test_route_order_considers_transition_quality_not_only_recommendation_score():
    current = analysis(bpm=120, key="C")
    candidates = [
        (item("high-relevance-bad-mix", 1.0), analysis(bpm=173, key="F#")),
        (item("clean-mix", 0.65), analysis(bpm=121, key="G")),
    ]
    route = order_route(current, candidates, profile="long_blend", limit=2)
    assert route[0]["id"] == "clean-mix"


def test_route_keeps_source_contract_and_does_not_penalise_cold_external_audio():
    current = {**analysis(), "analysed": True}
    cached_local = {
        **item("cached-local", 0.95),
        "source_pool": "local",
        "semantic_score": 0.7,
    }
    cold_external = {
        **item("cold-external", 0.8),
        "source_pool": "related",
        "semantic_score": 0.9,
    }
    route = order_route(
        current,
        [
            (cached_local, {**analysis(), "analysed": True}),
            (cold_external, {**analysis(confidence=0.18), "analysed": False}),
        ],
        profile="adaptive",
        limit=2,
        source_sequence=("related", "local"),
    )

    assert [row["id"] for row in route] == ["cold-external", "cached-local"]


def test_analyser_decodes_in_memory_and_finds_a_real_pulse_grid(tmp_path, monkeypatch):
    source = tmp_path / "click.wav"
    sample_rate = 11025
    with wave.open(str(source), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(sample_rate)
        frames = []
        for index in range(sample_rate * 18):
            time_sec = index / sample_rate
            phase = time_sec % 0.5  # 120 BPM
            value = (
                0.8 * math.sin(2 * math.pi * 880 * time_sec) * max(0, 1 - phase / 0.04)
                if phase < 0.04
                else 0
            )
            frames.append(struct.pack("<h", int(value * 32767)))
        output.writeframes(b"".join(frames))
    monkeypatch.setattr("shared.dj_engine._cache_path", lambda: tmp_path / "analysis.sqlite3")

    result = analyse_audio(source, "synthetic-click")

    assert result["analysed"] is True
    assert 112 <= result["bpm"] <= 124
    assert len(result["beat_grid"]) >= 24
    assert result["downbeats"]
    assert result["phrase_boundaries"]
    assert result["sections"]
    assert result["tempo_confidence"] > 0
    # Decoding happens in memory: the only things on disk are the source and the
    # analysis cache. `-wal`/`-shm` are that cache's own sidecars.
    written = {
        path for path in tmp_path.glob("*")
        if not path.name.startswith("analysis.sqlite3-")
    }
    assert written == {source, tmp_path / "analysis.sqlite3"}


def test_unknown_duration_yields_no_cue_rather_than_a_cue_at_zero():
    # A fallback analysis with no duration hint used to report an outro at 0.0,
    # which the player read as "mix out of this track immediately". Saying
    # nothing lets the player place a fade against the duration it really has.
    unmeasured = analyse_audio("", "missing")
    assert unmeasured["outro_cue"] is None
    assert unmeasured["analysed"] is False

    transition = plan_transition(unmeasured, analysis(), profile="adaptive")
    assert transition["out_cue"] is None
    assert transition["confidence"] < 0.35


def test_analysis_is_cached_by_content_and_reused_without_decoding(tmp_path, monkeypatch):
    source = _click_track(tmp_path / "click.wav")
    monkeypatch.setattr("shared.dj_engine._cache_path", lambda: tmp_path / "analysis.sqlite3")

    first = analyse_audio(source, "cache-me")
    assert cached_analysis(source, "cache-me") == first

    # A second read must not touch FFmpeg: planning depends on it being free.
    monkeypatch.setattr(
        "shared.dj_engine._decode",
        lambda *args, **kwargs: pytest.fail("cached analysis decoded again"),
    )
    assert analyse_audio(source, "cache-me") == first
    assert cached_analysis(source, "never-analysed") is None


def test_background_analysis_leaves_the_result_in_the_cache(tmp_path, monkeypatch):
    source = _click_track(tmp_path / "click.wav")
    monkeypatch.setattr("shared.dj_engine._cache_path", lambda: tmp_path / "analysis.sqlite3")

    request_analysis(source, "queued-track")
    for _ in range(200):
        if cached_analysis(source, "queued-track") is not None:
            break
        time.sleep(0.05)

    result = cached_analysis(source, "queued-track")
    assert result is not None and result["analysed"] is True


def _click_track(path, seconds=18):
    sample_rate = 11025
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(sample_rate)
        frames = []
        for index in range(sample_rate * seconds):
            time_sec = index / sample_rate
            phase = time_sec % 0.5  # 120 BPM
            value = (
                0.8 * math.sin(2 * math.pi * 880 * time_sec) * max(0, 1 - phase / 0.04)
                if phase < 0.04
                else 0
            )
            frames.append(struct.pack("<h", int(value * 32767)))
        output.writeframes(b"".join(frames))
    return path


def test_analysis_cache_survives_a_concurrent_reader(tmp_path, monkeypatch):
    """Opening a connection while another thread reads must not fail.

    `PRAGMA journal_mode=WAL` needs a lock a reader will not yield, so it has to
    come after `busy_timeout` and tolerate failure. Getting that order wrong
    made every background analysis die silently inside its worker.
    """
    monkeypatch.setattr("shared.dj_engine._cache_path", lambda: tmp_path / "analysis.sqlite3")
    from shared.dj_engine import _connect

    reader = _connect()
    # Hold an open read against the same file.
    reader.execute("SELECT * FROM audio_analysis").fetchall()

    errors: list[BaseException] = []

    def open_from_another_thread() -> None:
        try:
            _connect().execute("SELECT 1").fetchone()
        except BaseException as exc:  # noqa: BLE001 — reported by the assertion
            errors.append(exc)

    thread = threading.Thread(target=open_from_another_thread)
    thread.start()
    thread.join()

    assert not errors, f"second connection failed: {errors[0]!r}"
