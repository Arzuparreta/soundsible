"""Block boundaries must not change the musical measurements."""

import numpy as np
import pytest

from shared.dj import features as dj_features
from shared.dj import analysis as dj_analysis
from shared.dj.features import _spectral_features


@pytest.mark.parametrize("count", [1, 255, 256, 257, 513])
def test_bounded_fft_matches_whole_matrix(count):
    samples = np.random.default_rng(17).normal(size=(count, 2048)).astype(np.float32)
    spectrum = np.abs(np.fft.rfft(samples * np.hanning(2048), axis=1))
    expected_rms = np.sqrt(np.mean(samples * samples, axis=1) + 1e-12)
    power = spectrum[:, 9:465] ** 2 + 1e-12
    expected_flatness = np.exp(np.log(power).mean(axis=1)) / power.mean(axis=1)
    edges = [9, 17, 33, 66, 132, 263, 526, 929]
    expected_bands = np.stack([(spectrum[:, a:b] ** 2).sum(axis=1) for a, b in zip(edges, edges[1:])], axis=1)
    rms, flatness, bands = _spectral_features(samples, flatness_bins=slice(9, 465), band_bins=edges)
    np.testing.assert_array_equal(rms, expected_rms)
    np.testing.assert_allclose(flatness, expected_flatness, rtol=1e-12)
    np.testing.assert_allclose(bands, expected_bands, rtol=1e-5)


def test_fft_working_set_does_not_grow_with_track_length(monkeypatch):
    original = np.fft.rfft
    batches = []

    def measured(values, *args, **kwargs):
        batches.append(len(values))
        return original(values, *args, **kwargs)

    monkeypatch.setattr(np.fft, "rfft", measured)
    _spectral_features(np.zeros((1025, 2048), dtype=np.float32))
    assert sum(batches) == 1025
    assert max(batches) <= 256


@pytest.mark.parametrize("kind", ["silence", "tone", "pulse", "sweep"])
def test_complete_analysis_matches_whole_spectrum(monkeypatch, kind):
    rate = 11025
    t = np.arange(rate * 18, dtype=np.float32) / rate
    samples = {
        "silence": np.zeros_like(t),
        "tone": .25 * np.sin(2 * np.pi * 220 * t),
        "pulse": .25 * np.sin(2 * np.pi * 880 * t) * np.exp(-np.mod(t, .5) * 70),
        "sweep": .25 * np.sin(2 * np.pi * (110 * t + 30 * t * t)),
    }[kind].astype(np.float32)
    actual = dj_analysis._compose(samples, samples, rate, duration=18, tail_start=0)

    def whole_matrix(frames, *, flatness_bins, band_bins):
        spectrum = np.abs(np.fft.rfft(frames * np.hanning(frames.shape[1]), axis=1))
        rms = np.sqrt(np.mean(frames * frames, axis=1) + 1e-12)
        power = spectrum[:, flatness_bins] ** 2 + 1e-12
        flatness = np.exp(np.log(power).mean(axis=1)) / power.mean(axis=1)
        bands = np.stack([(spectrum[:, a:b] ** 2).sum(axis=1)
                          for a, b in zip(band_bins, band_bins[1:])], axis=1).astype(np.float32)
        return rms, flatness, bands

    monkeypatch.setattr(dj_features, '_spectral_features', whole_matrix)
    expected = dj_analysis._compose(samples, samples, rate, duration=18, tail_start=0)
    assert actual == expected
