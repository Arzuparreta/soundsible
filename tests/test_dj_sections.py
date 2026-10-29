"""Measured roles choose cues; a followed pulse cannot promise beatmatch."""

import copy
import json
import wave
from pathlib import Path

import numpy as np
import pytest

from shared.dj.contracts import fallback_analysis as _fallback
from shared.dj_engine import plan_transition


def phrases(grid, *, bars=8, evidence="counted"):
    """Phrase starts every `bars` four-beat bars of `grid`."""
    return [{"start": start, "bars": bars, "evidence": evidence} for start in grid[::4 * bars]]


def metric_region(grid, *, period, duration, start=0.):
    """One confirmed 4/4 region over the whole measured grid."""
    return {"start": start, "end": duration, "period": period, "pulse_unit": "quarter",
            "beats_per_bar": 4, "subdivision": 2, "bar_seconds": 4 * period,
            "pulse_confidence": 1., "metre_confidence": 1., "downbeat_confidence": 1.,
            "subdivision_confidence": 1., "downbeats": grid[::4]}


def measured(*, bpm=120, duration=240, offset=0.25):
    period = 60 / bpm
    grid = [round(offset + index * period, 4) for index in range(int((duration - offset) / period) + 1)]
    return {"analysed": True, "bpm": bpm, "duration": duration, "confidence": .9,
            "tempo_confidence": 1., "key": "C", "mode": "major", "bar_seconds": 4 * period,
            "beat_grid": grid, "downbeats": grid[::4], "phrases": phrases(grid),
            "metric_regions": [metric_region(grid, period=period, duration=duration)],
            "intro_cue": offset, "outro_cue": 192.25, "sections": []}


def section(start, end, label):
    return {"start": start, "end": end, "label": label}


def section_song(path, *, incoming=False, outro=False, drift=0, long=False, phase=False):
    """Four-minute 120 BPM signal whose arrangement changes at known bars.

    The incoming has a breakdown 11.5 dB quieter from 32.25 s and its drop at
    64.25 s; the outgoing a quiet region at 208.25 s (or an outro at
    224.25 s). `phase`: instead, the outgoing alternates 4 dB every eight
    bars from bar 5, a phrase phase that counting from its first one misses.
    Chords accent bars.
    """
    from test_dj_beat_grid import RATE, song

    song(path, 120, seconds=240, first=.25, drift=drift)
    with wave.open(str(path), "rb") as source:
        samples = np.frombuffer(source.readframes(source.getnframes()), dtype="<i2").astype(float)
    times = np.arange(len(samples)) / RATE
    envelope = np.full(len(samples), .45)
    if long:
        envelope[times < 64.25 if incoming else times >= 176.25] = .12
    elif incoming:
        envelope[(times >= 32.25) & (times < 64.25)] = .12
    elif phase:
        envelope[:] = .72
        envelope[(times >= 10.25) & ((times - 10.25) // 16 % 2 == 0)] = .45
        envelope[times >= 218.25] = .72
    elif outro:
        envelope[times >= 224.25] = .12
    else:
        envelope[(times >= 208.25) & (times < 224.25)] = .12
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(RATE)
        output.writeframes((samples * envelope).astype("<i2").tobytes())


@pytest.mark.parametrize("duration", [240., 240.001])
def test_exit_at_outro_shortens_blend_to_fit_without_moving_the_section(duration):
    # AAC decoders can retain one more millisecond than the original PCM.
    out = measured(duration=duration)
    out["sections"] = [section(224.25, duration, "outro")]
    plan = plan_transition(out, measured())
    assert plan["out_cue"] == 224.25
    assert plan["overlap_seconds"] == round(duration - 224.25 - 1.5, 3)
    assert plan["out_cue"] + plan["overlap_seconds"] == pytest.approx(duration - 1.5)


def test_finish_before_breakdown_and_treat_contiguous_blocks_as_one_section():
    out = measured()
    out["sections"] = [section(208.25, 224.25, "breakdown"), section(224.25, 240, "breakdown")]
    plan = plan_transition(out, measured())
    assert plan["out_cue"] == 176.25
    assert plan["out_cue"] + plan["overlap_seconds"] == 208.25


@pytest.mark.parametrize("start,label", [(64.25, "outro"), (96.25, "breakdown"), (239, "outro")])
def test_unusable_sections_do_not_replace_the_phrase_fallback(start, label):
    out = measured()
    expected = plan_transition(out, measured())
    out["sections"] = [section(start, 240, label)]
    assert plan_transition(out, measured()) == expected


@pytest.mark.parametrize("bpm", [120, 125, 60])
def test_incoming_drop_lands_on_the_outgoing_phrase_at_executed_speed(bpm):
    out, inc = measured(), measured(bpm=bpm, offset=.75)
    # A drop around 64 s, after a build longer than the blend.
    drop = inc["phrases"][round(64 / (32 * 60 / bpm))]["start"]
    inc["sections"] = [section(.75, drop, "build"), section(drop, drop + 16, "drop")]
    original = copy.deepcopy((out, inc))
    plan = plan_transition(out, inc)
    assert plan["technique"] == "bass_swap"
    assert plan["in_cue"] > inc["intro_cue"]
    assert plan["in_cue"] in inc["downbeats"]
    end = plan["out_cue"] + plan["overlap_seconds"]
    assert end in [row["start"] for row in out["phrases"]]
    assert (drop - plan["in_cue"]) / plan["playback_rate"] == pytest.approx(plan["overlap_seconds"], abs=.005)
    assert (out, inc) == original


def test_drop_alignment_is_omitted_when_no_measured_phrase_or_rate_fits():
    # The second outgoing grid is 10 % away, beyond the players' 8 % range.
    for changes in [{"phrases": []}, measured(bpm=132)]:
        out, inc = measured(), measured()
        inc["sections"] = [section(64.25, 80.25, "drop")]
        out.update(changes)
        assert plan_transition(out, inc)["in_cue"] == .25


def test_short_track_uses_the_players_overlap_limit_before_aligning_a_drop():
    out, inc = measured(duration=90), measured()
    out["outro_cue"] = 48.25
    inc["sections"] = [section(32.25, 48.25, "drop")]
    plan = plan_transition(out, inc)
    assert plan["out_cue"] >= 54
    assert plan["overlap_seconds"] <= 22.5
    assert plan["out_cue"] + plan["overlap_seconds"] <= 88.5
    assert (32.25 - plan["in_cue"]) / plan["playback_rate"] == pytest.approx(plan["overlap_seconds"], abs=.005)


@pytest.mark.parametrize("side", ["out", "in"])
@pytest.mark.parametrize("tempo_confidence", [0, .3, .6, None])
def test_tonal_confidence_does_not_override_an_unpredictable_pulse(side, tempo_confidence):
    out, inc = measured(), measured(bpm=125)
    (out if side == "out" else inc)["tempo_confidence"] = tempo_confidence
    plan = plan_transition(out, inc)
    assert plan["technique"] == "structural_fade"
    assert plan["fallback"] is True
    assert plan["playback_rate"] == 1


def test_cold_analysis_keeps_a_conservative_plan_and_no_drop_seek():
    plan = plan_transition(_fallback(), measured())
    assert plan["technique"] == "safe_fade"
    assert plan["out_cue"] is None
    assert plan["in_cue"] == .25
    assert plan["playback_rate"] == 1


def test_server_matches_the_transition_vectors_executed_by_web_and_android():
    vectors = Path(__file__).resolve().parents[1] / "shared/contracts/dj_structural_plans.json"
    for case in json.loads(vectors.read_text()):
        pair = []
        for side in ("outgoing", "incoming"):
            values = case[side]
            analysis = measured(**{key: value for key, value in values.items() if key in {"bpm", "duration", "offset"}})
            analysis.update({key: value for key, value in values.items() if key != "offset"})
            pair.append(analysis)
        assert plan_transition(*pair) == case["transition"], case["name"]
