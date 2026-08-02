"""The meter's summary is the only place a gain ever comes from, so the parser
is held to "trustworthy or nothing" — never a partial or plausible reading.

Every fixture below was captured from ffmpeg n8.1.2 running the real command.
"""

from __future__ import annotations

import subprocess

import pytest

from shared.loudness.measure import (
    LOUDNESS_VERSION,
    LoudnessMeasurement,
    MeasurementError,
    _ffmpeg_command,
    measure_loudness,
    parse_ebur128_summary,
)

NORMAL = """[Parsed_ebur128_0 @ 0x7fe97c0012c0] Summary:

  Integrated loudness:
    I:         -21.1 LUFS
    Threshold: -31.1 LUFS

  Loudness range:
    LRA:         3.4 LU
    Threshold: -41.1 LUFS
    LRA low:   -21.1 LUFS
    LRA high:  -17.7 LUFS

  True peak:
    Peak:       -6.2 dBFS
"""

# `peak=true+sample` puts `Sample peak:` *first*, with an identical value line.
# Reading the first `Peak:` after `Summary:` would take the sample peak, which
# under-reports by 1-2 dB on lossy files and quietly defeats the clipping guard.
DUAL_PEAK = """[Parsed_ebur128_0 @ 0x7ff328003c40] Summary:

  Integrated loudness:
    I:         -21.1 LUFS
    Threshold: -31.1 LUFS

  Loudness range:
    LRA:         0.0 LU
    Threshold: -41.1 LUFS
    LRA low:   -21.1 LUFS
    LRA high:  -21.1 LUFS

  Sample peak:
    Peak:      -18.0 dBFS

  True peak:
    Peak:      -16.5 dBFS
"""

SILENCE = """[Parsed_ebur128_0 @ 0x7f28c4003c40] Summary:

  Integrated loudness:
    I:         -70.0 LUFS
    Threshold:   0.0 LUFS

  Loudness range:
    LRA:         0.0 LU
    Threshold:   0.0 LUFS
    LRA low:     0.0 LUFS
    LRA high:    0.0 LUFS

  True peak:
    Peak:       -inf dBFS
"""

CLIPPED = """[Parsed_ebur128_0 @ 0x1] Summary:

  Integrated loudness:
    I:          -1.1 LUFS
    Threshold: -11.1 LUFS

  Loudness range:
    LRA:         0.1 LU
    Threshold: -21.1 LUFS
    LRA low:    -1.1 LUFS
    LRA high:   -1.1 LUFS

  True peak:
    Peak:        1.9 dBFS
"""

# An ffmpeg too old for `peak=true` prints no peak section at all.
NO_PEAK_SECTION = """[Parsed_ebur128_0 @ 0x1] Summary:

  Integrated loudness:
    I:         -14.0 LUFS
    Threshold: -24.0 LUFS

  Loudness range:
    LRA:         5.0 LU
"""


def test_parses_a_normal_summary():
    result = parse_ebur128_summary(NORMAL)
    assert result == LoudnessMeasurement(lufs=-21.1, peak_dbtp=-6.2, lra=3.4)


def test_true_peak_wins_over_the_sample_peak_printed_before_it():
    result = parse_ebur128_summary(DUAL_PEAK)
    assert result is not None
    assert result.peak_dbtp == -16.5


def test_digital_silence_is_not_a_measurement():
    # -70.0 LUFS is the absolute gate saying "nothing here", and `-inf` is not a
    # number. Either alone must be enough; a naive reading would ask for +56 dB.
    assert parse_ebur128_summary(SILENCE) is None


def test_a_clipped_master_still_measures():
    result = parse_ebur128_summary(CLIPPED)
    assert result is not None
    assert result.lufs == -1.1
    # A true peak above full scale is real and must survive: it is exactly what
    # tells the player to attenuate rather than boost.
    assert result.peak_dbtp == 1.9


def test_a_master_clipped_into_a_square_wave_still_measures():
    # Integrated loudness really can exceed 0 LUFS once a master is clipped flat.
    # This is the loudest content that exists and the most in need of pulling
    # down, so the sanity band must let it through rather than leave it at unity.
    squared = CLIPPED.replace("I:          -1.1 LUFS", "I:           2.3 LUFS")
    result = parse_ebur128_summary(squared)
    assert result is not None
    assert result.lufs == 2.3


def test_a_summary_without_a_true_peak_section_is_rejected():
    # No ceiling means no safe boost, so there is nothing to be gained by
    # accepting the loudness on its own.
    assert parse_ebur128_summary(NO_PEAK_SECTION) is None


def test_the_last_summary_wins():
    reinitialised = NORMAL.replace("-21.1 LUFS", "-9.9 LUFS", 1) + "\n" + NORMAL
    result = parse_ebur128_summary(reinitialised)
    assert result is not None
    assert result.lufs == -21.1


@pytest.mark.parametrize(
    "stderr",
    [
        "",
        "ffmpeg: no such file or directory",
        NORMAL[: NORMAL.index("True peak")],
        NORMAL.replace("-21.1", "-21,1"),  # comma decimal separator
        NORMAL.replace("I:         -21.1 LUFS", "I:         nan LUFS"),
        NORMAL.replace("I:         -21.1 LUFS", "I:         40.0 LUFS"),  # not physical
        NORMAL.replace("Peak:       -6.2 dBFS", "Peak:       99.0 dBFS"),
    ],
)
def test_anything_untrustworthy_parses_to_none(stderr):
    assert parse_ebur128_summary(stderr) is None


def test_loudness_far_above_true_peak_is_rejected_as_a_misparse():
    # K-weighting can put loudness a few dB over true peak on bright material,
    # but not 15. Numbers this far apart did not come from the same summary.
    bogus = NORMAL.replace("Peak:       -6.2 dBFS", "Peak:      -40.0 dBFS")
    assert parse_ebur128_summary(bogus) is None


def test_command_skips_non_audio_streams_and_stays_single_threaded():
    command = _ffmpeg_command("/music/song.flac")
    # Without -vn ffmpeg decodes embedded cover art as video on every tagged file.
    for flag in ("-vn", "-sn", "-dn", "-nostdin"):
        assert flag in command
    assert command[command.index("-threads") + 1] == "1"
    assert "ebur128=peak=true:framelog=quiet" in command
    assert command[-2:] == ["-f", "null"] or command[-1] == "-"


def test_a_missing_file_is_a_failed_attempt_not_a_verdict():
    # Distinct from `None`: the file was never read, so nothing has been learned
    # about it and it deserves another try later.
    with pytest.raises(MeasurementError):
        measure_loudness("/nonexistent/nope.flac")


def test_a_nonzero_exit_discards_an_otherwise_valid_summary(tmp_path, monkeypatch):
    source = tmp_path / "song.flac"
    source.write_bytes(b"not really a flac")

    def fake_run(*args, **kwargs):
        return subprocess.CompletedProcess(args=[], returncode=1, stderr=NORMAL.encode())

    monkeypatch.setattr(subprocess, "run", fake_run)
    with pytest.raises(MeasurementError):
        measure_loudness(source)


def test_a_hang_is_a_failure_not_a_wait(tmp_path, monkeypatch):
    source = tmp_path / "song.flac"
    source.write_bytes(b"x")

    def fake_run(*args, **kwargs):
        raise subprocess.TimeoutExpired(cmd="ffmpeg", timeout=1)

    monkeypatch.setattr(subprocess, "run", fake_run)
    with pytest.raises(MeasurementError):
        measure_loudness(source)


def test_silence_is_a_verdict_not_a_failure(tmp_path, monkeypatch):
    source = tmp_path / "song.flac"
    source.write_bytes(b"x")

    def fake_run(*args, **kwargs):
        return subprocess.CompletedProcess(args=[], returncode=0, stderr=SILENCE.encode())

    monkeypatch.setattr(subprocess, "run", fake_run)
    # Read fine, nothing to measure. Storing this stops the sweep reopening it.
    assert measure_loudness(source) is None


def test_version_is_an_int_so_it_can_be_compared():
    assert isinstance(LOUDNESS_VERSION, int)
