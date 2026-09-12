"""Block boundaries must not change the musical measurements."""
import subprocess
import sys

import numpy as np
import pytest

from shared.dj_engine import _spectral_features


@pytest.mark.parametrize("count", [1, 255, 256, 257, 513])
def test_bounded_fft_matches_whole_matrix(count):
    samples = np.random.default_rng(17).normal(size=(count, 2048)).astype(np.float32)
    spectrum = np.abs(np.fft.rfft(samples * np.hanning(2048), axis=1))
    expected_rms = np.sqrt(np.mean(samples * samples, axis=1) + 1e-12)
    expected_flux = np.maximum(0.0, np.diff(spectrum, axis=0)).sum(axis=1)
    rms, mean, flux = _spectral_features(samples)
    np.testing.assert_array_equal(rms, expected_rms)
    np.testing.assert_allclose(mean, spectrum.mean(axis=0), rtol=1e-12)
    np.testing.assert_allclose(flux, expected_flux, rtol=1e-12)


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


def test_daemon_analysis_does_not_block_cooperative_http_loop():
    # Patch in a fresh process, just as run.py does; never contaminate pytest's
    # own threads. A native sleep stands in for non-cooperative numerical work.
    code = '''
from gevent import monkey
monkey.patch_all()
import gevent
import threading
from shared import dj_engine
native_sleep = monkey.get_original("time", "sleep")
native_id = monkey.get_original("_thread", "get_ident")
main_id = native_id()
seen = []
def compute(*args, **kwargs):
    assert native_id() != main_id
    native_sleep(0.15)
    return {"analysed": True}
dj_engine._compose = compute
job = gevent.spawn(dj_engine._compose_off_loop, None, None, 11025, duration=10, tail_start=0)
gevent.sleep(0.03)
assert not job.ready(), "numerical work blocked the request loop"
assert job.get(timeout=5) == {"analysed": True}
'''
    result = subprocess.run([sys.executable, '-c', code], capture_output=True, text=True, timeout=15)
    assert result.returncode == 0, result.stderr


@pytest.mark.parametrize("kind", ["silence", "tone", "pulse", "sweep"])
def test_complete_analysis_matches_whole_spectrum(monkeypatch, kind):
    from shared import dj_engine

    rate = 11025
    t = np.arange(rate * 18, dtype=np.float32) / rate
    samples = {
        "silence": np.zeros_like(t),
        "tone": .25 * np.sin(2 * np.pi * 220 * t),
        "pulse": .25 * np.sin(2 * np.pi * 880 * t) * np.exp(-np.mod(t, .5) * 70),
        "sweep": .25 * np.sin(2 * np.pi * (110 * t + 30 * t * t)),
    }[kind].astype(np.float32)
    actual = dj_engine._compose(samples, samples, rate, duration=18, tail_start=0)

    def whole_matrix(frames):
        spectrum = np.abs(np.fft.rfft(frames * np.hanning(frames.shape[1]), axis=1))
        rms = np.sqrt(np.mean(frames * frames, axis=1) + 1e-12)
        flux = np.maximum(0.0, np.diff(spectrum, axis=0)).sum(axis=1)
        return rms, spectrum.mean(axis=0), flux

    monkeypatch.setattr(dj_engine, '_spectral_features', whole_matrix)
    expected = dj_engine._compose(samples, samples, rate, duration=18, tail_start=0)
    assert actual == expected
