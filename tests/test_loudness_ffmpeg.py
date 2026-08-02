"""End-to-end calibration against a real ffmpeg.

The parser tests prove we read the summary correctly. These prove the *command*
is right — that we are metering the audio we think we are, at the scale we think
we are. Assertions are relative (a file against the same file 6 dB down) rather
than absolute, because the absolute value depends on ffmpeg's `sine` amplitude
and would rot across releases while telling us nothing extra.
"""

from __future__ import annotations

import shutil
import subprocess

import pytest

import shared.ffmpeg_runtime as ffmpeg_runtime
from shared.ffmpeg_runtime import ffmpeg_executable
from shared.loudness.measure import MeasurementError, measure_loudness


@pytest.fixture(autouse=True)
def real_ffmpeg():
    """Resolve ffmpeg fresh, and only run against a real one.

    `shared.ffmpeg_runtime` memoises the resolved binary in a module global,
    which is right in production and sticky in a test session: whoever pointed
    it at a stub earlier leaves that stub behind for everyone after them. These
    tests exist to exercise the actual meter, so they clear the memo first and
    skip outright if what comes back is not a working ffmpeg.
    """
    ffmpeg_runtime._RESOLVED = None
    resolved = ffmpeg_runtime.resolve_ffmpeg()
    if resolved is None or shutil.which(str(resolved)) is None:
        pytest.skip("ffmpeg is not available")
    try:
        yield
    finally:
        ffmpeg_runtime._RESOLVED = None


def _synth(path, source: str, *filters: str) -> None:
    command = [ffmpeg_executable(), "-y", "-v", "error", "-f", "lavfi", "-i", source]
    if filters:
        command += ["-af", ",".join(filters)]
    command += ["-ac", "2", str(path)]
    subprocess.run(command, check=True, stdin=subprocess.DEVNULL, timeout=60)


@pytest.fixture
def tone(tmp_path):
    path = tmp_path / "tone.flac"
    _synth(path, "sine=frequency=1000:duration=8:sample_rate=44100")
    return path


def test_a_real_file_measures(tone):
    result = measure_loudness(tone)
    assert result is not None
    assert -70 < result.lufs <= 0
    assert -70 <= result.peak_dbtp <= 12


def test_attenuating_by_six_db_moves_both_numbers_by_six(tmp_path, tone):
    quieter = tmp_path / "quieter.flac"
    _synth(quieter, "sine=frequency=1000:duration=8:sample_rate=44100", "volume=-6dB")

    loud = measure_loudness(tone)
    soft = measure_loudness(quieter)
    assert loud is not None and soft is not None

    # This is the calibration proof: if the filter chain, the channel layout or
    # the scale were wrong, this difference would not be 6 dB.
    assert loud.lufs - soft.lufs == pytest.approx(6.0, abs=0.3)
    assert loud.peak_dbtp - soft.peak_dbtp == pytest.approx(6.0, abs=0.3)


def test_the_policy_levels_two_real_files_to_the_target(tmp_path):
    # Mirror of the player's rule (ui_web/src/lib/loudness.ts) applied to real
    # measurements. Both tones sit above the target, so neither hits the +6 dB
    # boost cap and both must land on -14 LUFS.
    target, ceiling = -14.0, -1.0

    def gain_db(m):
        return min(max(min(target - m.lufs, 6.0), -15.0), ceiling - m.peak_dbtp)

    loudish, louder = tmp_path / "a.flac", tmp_path / "b.flac"
    _synth(loudish, "sine=frequency=1000:duration=8:sample_rate=44100", "volume=10dB")
    _synth(louder, "sine=frequency=1000:duration=8:sample_rate=44100", "volume=16dB")

    a, b = measure_loudness(loudish), measure_loudness(louder)
    assert a is not None and b is not None
    assert b.lufs - a.lufs == pytest.approx(6.0, abs=0.3)

    assert a.lufs + gain_db(a) == pytest.approx(target, abs=0.4)
    assert b.lufs + gain_db(b) == pytest.approx(target, abs=0.4)


def test_the_boost_cap_binds_on_very_quiet_material(tmp_path, tone):
    # Two quiet files stay their original distance apart because both are capped
    # at +6 dB. That is the cap doing its job, not the policy failing: beyond
    # +6 dB we would be amplifying noise floor and codec artefacts.
    target, ceiling = -14.0, -1.0

    def gain_db(m):
        return min(max(min(target - m.lufs, 6.0), -15.0), ceiling - m.peak_dbtp)

    quieter = tmp_path / "quieter.flac"
    _synth(quieter, "sine=frequency=1000:duration=8:sample_rate=44100", "volume=-6dB")

    loud, soft = measure_loudness(tone), measure_loudness(quieter)
    assert loud is not None and soft is not None
    assert gain_db(loud) == pytest.approx(6.0, abs=0.01)
    assert gain_db(soft) == pytest.approx(6.0, abs=0.01)


def test_digital_silence_yields_no_measurement(tmp_path):
    path = tmp_path / "silence.flac"
    _synth(path, "anullsrc=r=44100:cl=stereo:d=5")
    # -70.0 LUFS with an -inf peak is the meter saying "nothing here". Reading it
    # as a measurement would ask the player for +56 dB.
    assert measure_loudness(path) is None


def test_a_fragment_shorter_than_a_gating_block_yields_nothing(tmp_path):
    path = tmp_path / "blip.flac"
    _synth(path, "sine=frequency=1000:duration=0.1:sample_rate=44100")
    assert measure_loudness(path) is None


def test_a_clipped_master_reports_a_positive_true_peak(tmp_path):
    path = tmp_path / "hot.flac"
    _synth(path, "sine=frequency=1000:duration=8:sample_rate=44100", "volume=25dB")
    result = measure_loudness(path)
    assert result is not None
    # True peak above full scale is exactly what tells the player to attenuate.
    assert result.peak_dbtp > 0


def test_a_file_that_is_not_audio_is_a_failed_attempt(tmp_path):
    path = tmp_path / "fake.mp3"
    path.write_text("this is plain text pretending to be an mp3")
    # ffmpeg refuses it outright, so this is an attempt that failed rather than
    # a verdict about the audio — the store backs off and gives up after three.
    with pytest.raises(MeasurementError):
        measure_loudness(path)
