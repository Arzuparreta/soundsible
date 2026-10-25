"""The DJ's per-song measures are physical magnitudes with a known answer.

Notes per second, spectral flatness and integrated loudness are checked
against synthetic signals whose value is known by construction: no song
is rated by a person.
"""
import math
import wave

import numpy as np
import pytest

from shared.dj import analysis as dj_analysis
from shared.dj import features as dj_features
from shared.dj import store as dj_store
from shared import dj_engine

RATE = 11025
# Hall reverberation: RT60 2 s, reverberant level 6 dB under the direct sound.
HALL = 2.0
HALL_GAIN = 0.5


def _reverb(signal, seconds, rng):
    t = np.arange(int(seconds * 1.2 * RATE)) / RATE
    response = rng.normal(size=t.size) * np.exp(-6.91 * t / seconds)
    response /= np.sqrt(np.sum(response ** 2))
    size = 1 << int(math.ceil(math.log2(signal.size + response.size)))
    wet = np.fft.irfft(np.fft.rfft(signal, size) * np.fft.rfft(response, size), size)[: signal.size]
    return signal + HALL_GAIN * wet


def _melody(rate, *, legato, vibrato_cents=0.0, hall=False, seconds=20.0, seed=1):
    """One voice of `rate` notes per second, each a different pitch.

    Legato notes follow each other with an 8 ms glide and no change of level;
    staccato notes strike in 5 ms, decay and stop before the next one.
    """
    rng = np.random.default_rng(seed)
    n = int(seconds * RATE)
    t = np.arange(n) / RATE
    frequency = np.zeros(n)
    envelope = np.zeros(n)
    pitch = 72
    for index in range(int(seconds * rate)):
        step = pitch
        while step == pitch:
            step = int(np.clip(pitch + rng.integers(-5, 6), 60, 84))
        pitch = step
        first, last = int(index / rate * RATE), int((index + 1) / rate * RATE)
        frequency[first:last] = 440 * 2 ** ((pitch - 69) / 12)
        local = np.arange(last - first) / RATE
        if legato:
            envelope[first:last] = 1.0
        else:
            length = 0.4 / rate
            envelope[first:last] = (
                np.clip(local / 0.005, 0, 1) * np.exp(-local / (length / 2))
                * np.clip((2 * length - local) / 0.02, 0, 1)
            )
    nominal = frequency
    if legato:
        glide = int(0.008 * RATE)
        nominal = np.convolve(frequency, np.ones(glide) / glide, mode="same")
        envelope[: int(0.01 * RATE)] *= np.linspace(0, 1, int(0.01 * RATE))
    played = nominal * 2 ** (vibrato_cents / 1200 * np.sin(2 * np.pi * 5.5 * t + rng.uniform(0, 6)))
    phase = 2 * np.pi * np.cumsum(played) / RATE
    tone = sum(np.where(nominal * h < RATE / 2 - 400, np.sin(h * phase) / h, 0) for h in range(1, 7))
    signal = envelope * tone + 1e-4 * rng.normal(size=n)
    if hall:
        signal = _reverb(signal, HALL, rng)
    return (0.5 * signal / np.max(np.abs(signal))).astype(np.float32)


def _repeated_chords(rate, *, dip_db, seconds=20.0, seed=5):
    """Four bowed voices strike the same chord `rate` times per second in a hall.

    Between strokes the level falls by `dip_db` and rises again in 10 ms; the
    chord changes every 2 s, on a stroke.
    """
    rng = np.random.default_rng(seed)
    n = int(seconds * RATE)
    t = np.arange(n) / RATE
    period = 1.0 / rate
    local = np.mod(t, period)
    floor = 10 ** (-dip_db / 20)
    envelope = floor + (1 - floor) * np.clip(local / 0.01, 0, 1) * np.clip((period - local) / min(0.03, period / 3), 0, 1)
    roots = rng.integers(48, 60, size=int(math.ceil(seconds / 2)))
    signal = np.zeros(n)
    for voice, interval in enumerate((0, 7, 12, 16)):
        frequency = 440 * 2 ** ((roots[(t // 2).astype(int)] + interval - 69) / 12)
        frequency = frequency * 2 ** (15 / 1200 * np.sin(2 * np.pi * (5 + voice * 0.3) * t + voice))
        phase = 2 * np.pi * np.cumsum(frequency) / RATE
        signal += sum(np.sin(h * phase) / h for h in range(1, 9))
    signal = _reverb(envelope * signal + 1e-4 * rng.normal(size=n), 1.5, rng)
    return (0.5 * signal / np.max(np.abs(signal))).astype(np.float32)


def _choir(changes_per_second, *, seconds=30.0, seed=2):
    """Four voices hold chords with vibrato and slow swells in a hall."""
    rng = np.random.default_rng(seed)
    n = int(seconds * RATE)
    t = np.arange(n) / RATE
    roots = rng.integers(48, 60, size=int(seconds * changes_per_second))
    chord = np.minimum((t * changes_per_second).astype(int), roots.size - 1)
    signal = np.zeros(n)
    glide = int(0.06 * RATE)
    for voice, interval in enumerate((0, 7, 12, 16)):
        frequency = 440 * 2 ** ((roots[chord] + interval - 69) / 12)
        frequency = np.convolve(np.pad(frequency, glide, mode="edge"), np.ones(glide) / glide, mode="same")[glide:-glide]
        frequency = frequency * 2 ** (20 / 1200 * np.sin(2 * np.pi * (4.8 + voice * 0.4) * t + voice))
        phase = 2 * np.pi * np.cumsum(frequency) / RATE
        swell = 0.7 + 0.3 * np.sin(2 * np.pi * 0.13 * t + voice)
        signal += swell * sum(np.sin(h * phase) / h ** 1.2 for h in range(1, 8))
    signal = _reverb(signal + 1e-4 * rng.normal(size=n), HALL, rng)
    return (0.5 * signal / np.max(np.abs(signal))).astype(np.float32)


def _drums(bpm, *, seconds=20.0, seed=3):
    """Kick on every beat, closed hat on every eighth: two hits per beat."""
    rng = np.random.default_rng(seed)
    n = int(seconds * RATE)
    signal = np.zeros(n)
    beat = 60 / bpm
    t = np.arange(int(0.25 * RATE)) / RATE
    kick = np.sin(2 * np.pi * (50 * t + 2.2 * (1 - np.exp(-t / 0.04)))) * np.exp(-t / 0.12)
    hat = rng.normal(size=int(0.04 * RATE)) * np.exp(-np.arange(int(0.04 * RATE)) / (0.01 * RATE))
    hits = 0
    while hits * beat / 2 < seconds - 0.3:
        first = int(hits * beat / 2 * RATE)
        if hits % 2 == 0:
            signal[first:first + kick.size] += kick[: n - first]
        signal[first:first + hat.size] += 0.3 * hat[: n - first]
        hits += 1
    return (0.5 * signal / np.max(np.abs(signal))).astype(np.float32), hits / seconds


def note_rate(samples):
    notes, seconds = dj_features._note_onsets(samples, RATE)
    return notes / seconds if seconds else 0.0


@pytest.mark.parametrize("rate", [1, 2, 4, 8, 12])
@pytest.mark.parametrize("legato", [True, False], ids=["legato", "staccato"])
@pytest.mark.parametrize(("vibrato", "hall"), [(0.0, False), (50.0, False), (0.0, True), (50.0, True)],
                         ids=["dry", "vibrato", "hall", "vibrato-hall"])
def test_a_melody_measures_its_notes_per_second(rate, legato, vibrato, hall):
    # A 50-cent vibrato moves every partial by up to half a semitone five
    # times a second; it is one held note, not five.
    measured = note_rate(_melody(rate, legato=legato, vibrato_cents=vibrato, hall=hall, seed=rate * 7 + legato))
    assert measured == pytest.approx(rate, rel=0.25)


@pytest.mark.parametrize("rate", [2, 4, 6, 8])
def test_repeated_strokes_of_one_chord_are_notes(rate):
    assert note_rate(_repeated_chords(rate, dip_db=12)) == pytest.approx(rate, rel=0.25)


def test_shallow_repeated_strokes_are_undercounted_but_still_ordered():
    # Known limit: when the level falls only 6 dB between strokes of the same
    # chord and the hall fills the gap, about 60 % of the strokes are missed.
    # More strokes still measure more.
    measured = [note_rate(_repeated_chords(rate, dip_db=6)) for rate in (2, 4, 8)]
    assert measured == sorted(measured)
    assert all(value >= 0.35 * rate for value, rate in zip(measured, (2, 4, 8)))


@pytest.mark.parametrize("changes", [0.25, 0.5, 1.0])
def test_held_choral_chords_count_their_changes(changes):
    assert note_rate(_choir(changes)) == pytest.approx(changes, abs=0.3)


@pytest.mark.parametrize("bpm", [100, 128])
def test_a_drum_pattern_counts_its_hits(bpm):
    samples, hits = _drums(bpm)
    assert note_rate(samples) == pytest.approx(hits, rel=0.25)


def test_counterpoint_measures_far_more_notes_than_slow_choral_chords():
    # The shape of the acceptance case in docs/dj/HANDOFF.md, P4: a fugue in
    # sixteenths against an adagio for voices.
    voices = sum(_melody(5, legato=True, hall=True, seed=seed).astype(float) for seed in (11, 12))
    assert note_rate(voices.astype(np.float32)) > 5 * note_rate(_choir(0.5))


def test_noise_and_a_drone_have_no_notes():
    rng = np.random.default_rng(4)
    assert note_rate((0.3 * rng.normal(size=20 * RATE)).astype(np.float32)) < 1.0
    t = np.arange(20 * RATE) / RATE
    drone = 0.3 * sum(np.sin(2 * np.pi * 220 * h * t) / h for h in range(1, 6))
    assert note_rate(drone.astype(np.float32)) == 0.0


def test_note_rate_does_not_depend_on_the_mastering_level():
    melody = _melody(4, legato=True, vibrato_cents=50.0, hall=True, seed=29)
    assert note_rate(melody * np.float32(0.02)) == pytest.approx(note_rate(melody), rel=0.05)


def test_rests_count_as_music_but_a_long_silence_does_not():
    melody = _melody(4, legato=False, seed=31)
    gapped = np.concatenate([melody, np.zeros(10 * RATE, dtype=np.float32), melody])
    assert note_rate(gapped) == pytest.approx(note_rate(melody), rel=0.1)


def test_note_counting_memory_does_not_grow_with_track_length(monkeypatch):
    original = np.fft.rfft
    batches = []

    def measured(values, *args, **kwargs):
        batches.append(len(values))
        return original(values, *args, **kwargs)

    monkeypatch.setattr(np.fft, "rfft", measured)
    dj_features._note_onsets(_melody(4, legato=True, seconds=60.0), RATE)
    assert max(batches) <= dj_features._NOTE_BLOCK


def _compose(samples):
    return dj_analysis._compose(samples, samples, RATE, duration=samples.size / RATE, tail_start=0)


def test_spectral_flatness_is_zero_for_a_tone_and_that_of_white_noise_for_noise():
    t = np.arange(20 * RATE) / RATE
    tone = _compose((0.3 * np.sin(2 * np.pi * 440 * t)).astype(np.float32))
    noise = _compose((0.3 * np.random.default_rng(8).normal(size=t.size)).astype(np.float32))
    assert tone["spectral_flatness"] < 0.01
    # The geometric over the arithmetic mean of an exponential variable,
    # which is what the power of white noise in one bin is: e^-γ.
    assert noise["spectral_flatness"] == pytest.approx(math.exp(-0.5772), abs=0.03)


def test_quiet_gaps_do_not_count_towards_flatness():
    melody = _melody(4, legato=True, seed=37)
    gapped = melody.copy()
    gapped[4 * RATE:12 * RATE] = np.random.default_rng(9).normal(scale=3e-3, size=8 * RATE)
    assert _compose(gapped)["spectral_flatness"] == pytest.approx(_compose(melody)["spectral_flatness"], abs=0.01)


def test_silence_measures_nothing():
    silent = _compose(np.zeros(20 * RATE, dtype=np.float32))
    assert silent["note_rate"] == 0.0
    assert silent["spectral_flatness"] == 0.0


def test_a_long_recording_pools_its_two_windows():
    slow, fast = _melody(2, legato=True, seed=41), _melody(8, legato=True, seed=43)
    duration = 900.0
    both = dj_analysis._compose(fast, slow, RATE, duration=duration, tail_start=duration - fast.size / RATE)
    assert both["note_rate"] == pytest.approx(5, rel=0.15)


def _write_stereo(path, samples, rate=48000):
    pcm = np.clip(np.repeat(samples[:, None], 2, axis=1) * 32767, -32768, 32767).astype("<i2")
    with wave.open(str(path), "wb") as output:
        output.setnchannels(2)
        output.setsampwidth(2)
        output.setframerate(rate)
        output.writeframes(pcm.tobytes())


def test_integrated_loudness_is_measured_by_ebu_r128_in_the_same_decode(tmp_path, monkeypatch):
    monkeypatch.setattr(dj_store, "_cache_path", lambda: tmp_path / "analysis.sqlite3")
    t = np.arange(12 * 48000) / 48000
    # A 997 Hz sine at -20 dBFS in both channels is -20 LUFS (BS.1770-4).
    tone = 10 ** (-20 / 20) * np.sin(2 * np.pi * 997 * t)
    _write_stereo(tmp_path / "tone.wav", tone)
    _write_stereo(tmp_path / "quiet.wav", tone * 10 ** (-12 / 20))

    assert dj_engine.analyse_audio(tmp_path / "tone.wav", "tone")["loudness_lufs"] == pytest.approx(-20, abs=0.2)
    assert dj_engine.analyse_audio(tmp_path / "quiet.wav", "quiet")["loudness_lufs"] == pytest.approx(-32, abs=0.2)


def test_the_meter_does_not_change_the_decoded_samples(tmp_path):
    t = np.arange(6 * 44100) / 44100
    _write_stereo(tmp_path / "chirp.wav", 0.3 * np.sin(2 * np.pi * (200 * t + 300 * t * t)), rate=44100)
    import subprocess

    from shared.ffmpeg_runtime import ffmpeg_executable

    plain = subprocess.run(
        [ffmpeg_executable(), "-v", "error", "-i", str(tmp_path / "chirp.wav"), "-vn", "-ac", "1", "-ar", str(RATE),
         "-f", "f32le", "pipe:1"],
        check=True, stdout=subprocess.PIPE,
    ).stdout
    samples, lufs = dj_store._decode_measured(tmp_path / "chirp.wav", RATE)
    assert samples.tobytes() == plain
    assert lufs is not None


def test_two_measured_windows_add_as_power():
    assert dj_store._combined_lufs([(-20.0, 90.0), (-20.0, 120.0)]) == pytest.approx(-20.0)
    # Equal lengths, 10 dB apart: the louder dominates, about 2.6 dB lower.
    assert dj_store._combined_lufs([(-10.0, 60.0), (-20.0, 60.0)]) == pytest.approx(-12.6, abs=0.05)
    assert dj_store._combined_lufs([(None, 90.0), (-14.0, 120.0)]) == pytest.approx(-14.0)
    assert dj_store._combined_lufs([(None, 90.0)]) is None
