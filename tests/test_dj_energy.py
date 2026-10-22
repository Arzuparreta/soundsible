"""Energy says how intense a song sounds, and is comparable between songs."""
import numpy as np

from shared import dj_engine

RATE = 11025
SECONDS = 24


def _compose(samples):
    samples = samples.astype(np.float32)
    return dj_engine._compose(samples, samples, RATE, duration=samples.size / RATE, tail_start=0)


def _calm(seed=3):
    """Sustained piano-like chords: power sits on a few harmonics."""
    rng = np.random.default_rng(seed)
    t = np.arange(RATE * SECONDS) / RATE
    out = np.zeros_like(t)
    for start in np.arange(0, SECONDS, 2.0):
        root = 220 * 2 ** (rng.integers(0, 12) / 12)
        local = t - start
        envelope = np.where(local >= 0, np.exp(-np.maximum(local, 0) / 1.4), 0)
        for ratio in (1, 1.26, 1.5):
            for harmonic in (1, 2, 3, 4):
                out += envelope * np.sin(2 * np.pi * root * ratio * harmonic * t) / harmonic ** 1.5
    return 0.2 * out / np.max(np.abs(out))


def _intense(seed=5):
    """Four-on-the-floor kick, noise snare and hats, and a clipped saw bass."""
    rng = np.random.default_rng(seed)
    t = np.arange(RATE * SECONDS) / RATE
    beat = 60 / 128
    out = np.zeros_like(t)
    phase = np.mod(t, beat)
    out += np.sin(2 * np.pi * 55 * phase) * np.exp(-phase / 0.12)
    noise = rng.normal(size=t.size)
    snare_phase = np.mod(t - beat, 2 * beat)
    out += 0.7 * noise * np.exp(-snare_phase / 0.08)
    hat_phase = np.mod(t, beat / 2)
    out += 0.35 * np.diff(np.r_[0, noise]) * np.exp(-hat_phase / 0.02)
    saw = 2 * np.mod(t * 110, 1) - 1
    out += np.clip(3 * saw, -1, 1) * 0.5
    return 0.5 * out / np.max(np.abs(out))


def test_dense_music_measures_more_energy_than_sustained_chords():
    calm = _compose(_calm())["energy"]
    intense = _compose(_intense())["energy"]
    assert calm < 0.3
    assert intense > 0.7


def test_energy_does_not_depend_on_the_mastering_level():
    # A quiet master of an intense song is still intense; the old measure,
    # a ratio to the song's own loud level, could not say either way.
    loud = _compose(_intense())["energy"]
    quiet = _compose(_intense() * 0.05)["energy"]
    assert abs(loud - quiet) <= 0.02
    assert _compose(_intense() * 0.05)["energy"] > _compose(_calm())["energy"] + 0.4


def test_silence_has_no_energy():
    assert _compose(np.zeros(RATE * SECONDS))["energy"] == 0.0


def test_quiet_gaps_do_not_count():
    # Hiss in a long pause is the flattest spectrum there is, but it is noise
    # floor, not music: counted, it lifts these chords to about 0.18.
    calm = _calm()
    gapped = calm.copy()
    gapped[RATE * 4:RATE * 16] = np.random.default_rng(9).normal(scale=3e-3, size=RATE * 12)
    assert abs(_compose(gapped)["energy"] - _compose(calm)["energy"]) <= 0.05


def test_a_long_recording_averages_its_two_windows():
    calm, intense = _calm(), _intense()
    head_only = _compose(calm)["energy"]
    tail_only = _compose(intense)["energy"]
    duration = 900.0
    both = dj_engine._compose(
        intense.astype(np.float32), calm.astype(np.float32), RATE,
        duration=duration, tail_start=duration - SECONDS,
    )["energy"]
    assert head_only < both < tail_only
