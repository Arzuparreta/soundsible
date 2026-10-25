"""The beat grid must be precise enough that two mixed kicks land as one.

Every song here is synthesised with known kick onsets, written to disk and
analysed through FFmpeg exactly as a library file would be.
"""
import math
import wave

import numpy as np
import pytest

from shared.dj import store as dj_store
from shared.dj import timing as dj_timing
from shared.dj_engine import analyse_audio, plan_transition

RATE = 22050
CHORDS = ((0, 4, 7), (9, 0, 4), (5, 9, 0), (7, 11, 2))


def _kick(kind, rng):
    t = np.arange(int(0.3 * RATE)) / RATE
    attack = {"sharp": 0.0008, "soft": 0.006}[kind]
    sweep = 50 + 110 * np.exp(-t / 0.04)
    body = np.sin(2 * np.pi * np.cumsum(sweep) / RATE)
    envelope = np.clip(t / attack, 0, 1) * np.exp(-np.maximum(0, t - attack) / 0.16)
    hit = body * envelope
    if kind == "sharp":
        click = int(0.002 * RATE)
        hit[:click] += 0.5 * rng.uniform(-1, 1, click)
    return hit


def _tone(frequency, seconds, attack):
    t = np.arange(int(seconds * RATE)) / RATE
    wave_ = sum(np.sin(2 * np.pi * frequency * h * t) / h for h in (1, 2, 3))
    envelope = np.clip(t / attack, 0, 1)
    release = min(t.size, int(0.02 * RATE))
    envelope[-release:] *= np.linspace(1, 0, release)
    return wave_ * envelope


def _add(buffer, start, sound, gain):
    first = int(round(start * RATE))
    end = min(buffer.size, first + sound.size)
    if 0 <= first < buffer.size:
        buffer[first:end] += gain * sound[: end - first]


def song(path, bpm, *, seconds=40.0, kick="sharp", offbeat_bass=False, drift=0.0, first=0.31, seed=1):
    """Write a four-to-the-floor song; returns (kick onsets, bar starts)."""
    rng = np.random.default_rng(seed)
    beats = []
    t = first
    while t < seconds - 0.6:
        beats.append(t)
        t += 60.0 / (bpm * (1 + drift * math.sin(2 * math.pi * t / 30.0)))
    beats = np.array(beats)
    buffer = np.zeros(int(seconds * RATE))
    hit = _kick(kind=kick, rng=rng)
    hat = np.diff(rng.uniform(-1, 1, int(0.05 * RATE)), prepend=0) * np.exp(-np.arange(int(0.05 * RATE)) / (0.012 * RATE))
    for index, start in enumerate(beats):
        step = (beats[index + 1] if index + 1 < beats.size else start + 60 / bpm) - start
        bar, position = divmod(index, 4)
        _add(buffer, start, hit, 1.0 if position == 0 else 0.8)
        _add(buffer, start + step / 2, hat, 0.3)
        root = 55.0 * 2 ** (CHORDS[bar % 4][0] / 12)
        if offbeat_bass:
            _add(buffer, start + step / 2, _tone(root, step * 0.45, 0.004), 0.3)
        if position == 0:
            for pitch in CHORDS[bar % 4]:
                _add(buffer, start, _tone(220 * 2 ** (pitch / 12), step * 4, 0.05), 0.05)
    buffer += 0.003 * rng.normal(size=buffer.size)
    buffer /= np.max(np.abs(buffer)) / 0.9
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(RATE)
        output.writeframes((buffer * 32000).astype("<i2").tobytes())
    return beats, beats[::4]


@pytest.fixture
def analysed(tmp_path, monkeypatch):
    monkeypatch.setattr(dj_store, "_cache_path", lambda: tmp_path / "analysis.sqlite3")

    def run(name, bpm, **options):
        path = tmp_path / f"{name}.wav"
        onsets, bars = song(path, bpm, **options)
        return analyse_audio(path, name), onsets, bars

    return run


def grid_errors(grid, onsets):
    """Signed distance (s) from each onset to the nearest grid point."""
    grid = np.asarray(grid)
    index = np.clip(np.searchsorted(grid, onsets), 1, grid.size - 1)
    nearest = np.where(np.abs(onsets - grid[index - 1]) < np.abs(onsets - grid[index]), grid[index - 1], grid[index])
    return nearest - onsets


# A kick with a click is marked at the click. One that swells over 6 ms with
# nothing sharper on the beat is marked about 3 ms into its swell, where the
# pre-emphasised level rises fastest; that is also roughly where a slow attack
# is heard.
TOLERANCE = {"sharp": 0.0015, "soft": 0.004}


@pytest.mark.parametrize(
    ("bpm", "kick"),
    [(118.0, "sharp"), (122.0, "soft"), (123.7, "sharp"), (127.85, "soft"), (140.0, "sharp")],
)
def test_tempo_and_beats_are_measured_to_the_millisecond(analysed, bpm, kick):
    # The previous analyser could only report 117.45 or 129.2 for every one of
    # these, and put its beats up to 23 ms either side of the kick.
    result, onsets, _ = analysed(f"steady-{bpm}", bpm, kick=kick)

    assert result["bpm"] == pytest.approx(bpm, abs=0.02)
    errors = grid_errors(result["beat_grid"], onsets)
    assert np.max(np.abs(errors)) < TOLERANCE[kick]
    assert result["tempo_confidence"] > 0.9


def test_an_off_beat_bass_line_does_not_capture_the_grid(analysed):
    # A bass note on every off-beat rises as sharply in the onset measure as
    # the kick does; the grid must still mark the kick.
    result, onsets, _ = analysed("offbeat-bass", 124.0, offbeat_bass=True, kick="soft")

    assert np.max(np.abs(grid_errors(result["beat_grid"], onsets))) < TOLERANCE["soft"]


def test_downbeats_mark_the_bar_where_harmony_changes(analysed):
    result, _, bars = analysed("bars", 126.0)

    inner = bars[2:-2]
    errors = grid_errors(result["downbeats"], inner)
    assert np.mean(np.abs(errors) < 0.005) > 0.95


def test_a_drifting_performance_gets_a_following_grid_and_less_trust(analysed):
    result, onsets, _ = analysed("drift", 110.0, drift=0.015, kick="sharp")

    errors = grid_errors(result["beat_grid"], onsets[4:-4])
    assert np.percentile(np.abs(errors), 90) < 0.015
    # Followed, not predicted: one playback rate cannot hold it for a whole blend.
    assert result["tempo_confidence"] < 0.7
    # Even two harmonically identical analyses must not promote a followed
    # clock to a fixed-rate beatmatch. This is analysis from real PCM.
    plan = plan_transition(result, result)
    assert plan["technique"] == "structural_fade"
    assert plan["playback_rate"] == 1


def test_a_sustained_sound_has_no_tempo(tmp_path, monkeypatch):
    # A drone gives the tracker nothing but rounding noise to follow; it must
    # not come back as a confident grid that the planner would beatmatch.
    monkeypatch.setattr(dj_store, "_cache_path", lambda: tmp_path / "analysis.sqlite3")
    t = np.arange(int(20 * RATE)) / RATE
    path = tmp_path / "drone.wav"
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(RATE)
        output.writeframes((0.3 * np.sin(2 * np.pi * 220 * t) * 32000).astype("<i2").tobytes())

    result = analyse_audio(path, "drone")

    assert result["analysed"] is True
    assert result["bpm"] == 0
    assert result["beat_grid"] == []
    assert result["tempo_confidence"] == 0


def test_two_mixed_songs_keep_their_kicks_together_for_the_whole_overlap(analysed):
    # Long enough for a 16-bar blend inside both players' 25% duration limit.
    outgoing, out_onsets, _ = analysed("out", 124.0, seconds=128.0, kick="sharp", seed=3)
    incoming, in_onsets, _ = analysed("in", 126.3, seconds=128.0, kick="soft", first=0.83, seed=4)

    plan = plan_transition(outgoing, incoming)
    assert plan["technique"] == "bass_swap"
    rate = plan["playback_rate"]
    assert rate == pytest.approx(124.0 / 126.3, abs=2e-5)

    # Map both songs onto the programme clock of the mix.
    mixed_out = out_onsets[(out_onsets >= plan["out_cue"] - 0.01)] - plan["out_cue"]
    mixed_out = mixed_out[mixed_out <= plan["overlap_seconds"]]
    mixed_in = (in_onsets - plan["in_cue"]) / rate
    flam = grid_errors(mixed_in, mixed_out)
    # The server now applies the same 25% runway limit as both players.
    assert plan["overlap_seconds"] <= outgoing["duration"] * .25
    assert mixed_out.size >= 60
    assert np.max(np.abs(flam)) < 0.003


def test_the_planned_cue_leaves_the_players_their_margin():
    # Both players move a cue later than `duration - overlap - 1`; one they
    # moved would no longer sit on a downbeat.
    grid = [round(0.25 + 0.5 * index, 4) for index in range(400)]
    outgoing = {
        "bpm": 120.0, "key": "C", "mode": "major", "confidence": 0.9, "analysed": True,
        "duration": 180.0, "bar_seconds": 2.0, "outro_cue": 146.25,
        "beat_grid": grid, "downbeats": grid[::4],
    }
    incoming = {**outgoing, "intro_cue": 0.25, "outro_cue": 120.0}

    plan = plan_transition(outgoing, incoming)

    assert plan["out_cue"] + plan["overlap_seconds"] <= 180.0 - 1.5
    assert plan["out_cue"] in grid[::4]


def test_local_period_resolves_tempo_below_the_grid_rounding():
    true_period = 60.0 / 121.37
    grid = [round(0.4 + true_period * index, 4) for index in range(300)]
    analysis = {"bpm": 121.4, "beat_grid": grid}

    measured = dj_timing.local_period(analysis, 60.0, 30.0)

    # 1e-6 s per beat is 0.1 ms of drift over a 32-bar blend.
    assert measured == pytest.approx(true_period, abs=1e-6)
