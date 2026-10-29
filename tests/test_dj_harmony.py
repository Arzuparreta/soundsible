"""Known pitches and the 24-key Camelot graph, without listener ratings."""
import json
import subprocess
import wave
from collections import deque

import numpy as np
import pytest

from docs.dj.key_probe import cadence
from shared.dj import features as dj_features
from shared.dj import store as dj_store
from shared.dj import transitions as dj_transitions
from shared import dj_engine as dj
from shared.ffmpeg_runtime import ffmpeg_executable


# Independent notation table, in wheel order, from the official Camelot chart.
MAJOR = ("B", "F#", "C#", "G#", "D#", "A#", "F", "C", "G", "D", "A", "E")
MINOR = ("G#", "D#", "A#", "F", "C", "G", "D", "A", "E", "B", "F#", "C#")


def test_all_key_pairs_follow_the_camelot_graph():
    nodes = [(index, mode) for index in range(12) for mode in ("major", "minor")]
    def analysis(node):
        index, mode = node
        return {"key": (MAJOR if mode == "major" else MINOR)[index], "mode": mode}

    for start in nodes:
        distances = {start: 0}
        pending = deque([start])
        while pending:
            index, mode = node = pending.popleft()
            neighbours = [((index - 1) % 12, mode), ((index + 1) % 12, mode),
                          (index, "minor" if mode == "major" else "major")]
            for neighbour in neighbours:
                if neighbour not in distances:
                    distances[neighbour] = distances[node] + 1
                    pending.append(neighbour)
        assert max(distances.values()) == 7
        for target in nodes:
            actual = dj_transitions._harmonic_score(analysis(start), analysis(target))
            assert actual == pytest.approx(1 - distances[target] / 7)
            assert actual == dj_transitions._harmonic_score(analysis(target), analysis(start))


@pytest.mark.parametrize("missing", [{}, {"key": "C"}, {"mode": "minor"},
                                     {"key": "?", "mode": "major"}, {"key": "C", "mode": "dorian"}])
def test_unknown_key_or_mode_keeps_the_neutral_fallback(missing):
    known = {"key": "C", "mode": "major"}
    assert dj_transitions._harmonic_score(known, missing) == .55
    assert dj_transitions._harmonic_score(missing, known) == .55


@pytest.mark.parametrize("octave,harmonics", [(3, 1), (1, 1), (3, 6), (1, 6)])
@pytest.mark.parametrize("mode", ["major", "minor"])
@pytest.mark.parametrize("tonic", range(12))
def test_cadences_identify_all_keys_across_register_and_timbre(tonic, mode, octave, harmonics):
    key, found_mode, margin = dj_features._tonal_features(cadence(tonic, mode, octave=octave, harmonics=harmonics), 11025)
    assert (key, found_mode) == (dj_features._KEY_NAMES[tonic], mode)
    assert 0 < margin <= 2


@pytest.mark.parametrize("cents", [-20, 20])
@pytest.mark.parametrize("mode", ["major", "minor"])
@pytest.mark.parametrize("tonic", range(12))
def test_small_tuning_offsets_do_not_change_the_key(tonic, mode, cents):
    key, found_mode, _ = dj_features._tonal_features(cadence(tonic, mode, harmonics=6, cents=cents), 11025)
    assert (key, found_mode) == (dj_features._KEY_NAMES[tonic], mode)


def test_silence_has_no_key():
    features = dj_features._window_features(np.zeros(11025 * 5, dtype=np.float32), 11025)
    assert features["key"] is None
    assert features["mode"] is None
    assert features["key_margin"] == 0


def test_tonal_fft_working_set_is_bounded(monkeypatch):
    original = np.fft.rfft
    batches = []
    def measured(values, *args, **kwargs):
        batches.append(len(values))
        return original(values, *args, **kwargs)
    monkeypatch.setattr(np.fft, "rfft", measured)
    assert dj_features._tonal_features(np.zeros(dj_features._TONAL_FRAME * 40, dtype=np.float32), 11025) == (None, None, 0)
    assert sum(batches) > dj_features._TONAL_BLOCK
    assert max(batches) <= dj_features._TONAL_BLOCK


@pytest.mark.parametrize("mode", ["major", "minor"])
@pytest.mark.parametrize("encoding", ["pcm", "aac"])
def test_decoded_cadence_replaces_old_cached_keys(tmp_path, monkeypatch, mode, encoding):
    monkeypatch.setattr(dj_store, "_cache_path", lambda: tmp_path / "analysis.sqlite3")
    source = tmp_path / "cadence.wav"
    with wave.open(str(source), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(11025)
        output.writeframes((cadence(0, mode, octave=1, harmonics=6) * 32767).astype("<i2").tobytes())
    if encoding == "aac":
        encoded = tmp_path / "cadence.m4a"
        subprocess.run([ffmpeg_executable(), "-v", "error", "-i", str(source),
                        "-ar", "44100", "-c:a", "aac", str(encoded)], check=True, timeout=30)
        source = encoded
    with dj_store._connect() as conn:
        conn.execute("INSERT INTO audio_analysis VALUES (?, ?, ?, ?, ?)",
                     ("cadence", dj_store._source_stamp(source), dj.ANALYSER_VERSION - 1,
                      json.dumps({"key": "A#", "mode": "minor"}), 0))
    assert dj.cached_analysis(source, "cadence") is None
    actual = dj.analyse_audio(source, "cadence")
    assert (actual["key"], actual["mode"]) == ("C", mode)
    assert actual["version"] == dj.ANALYSER_VERSION
    assert actual["analysed"] is True
    monkeypatch.setattr(dj_store, "_analyse_pcm", lambda *args, **kwargs: pytest.fail("decoded twice"))
    assert dj.analyse_audio(source, "cadence") == actual


def test_route_quality_prefers_a_relative_key_even_when_parallel_is_listed_first():
    from test_dj_sections import measured
    common = measured()
    current = {**common, "key": "C", "mode": "major"}
    candidates = [({"id": name, "score": .5}, {**common, "key": key, "mode": "minor"})
                  for name, key in (("parallel", "C"), ("relative", "A"))]
    route = dj.order_route(current, candidates, limit=2)
    assert route[0]["id"] == "relative"
