"""The beat model path without PyTorch or madmom: frontend, chunks, DBN, weights."""
import os
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

from shared.dj import beat_model, dbn, weights

FIXTURES = Path(__file__).resolve().parent / 'fixtures' / 'dj'


@pytest.mark.parametrize('case', ['3_2_plain', '4_2_drift', 'silence', 'structure_8_bars'])
def test_numpy_dbn_reproduces_madmom_on_beat_this_activations(case):
    # Logits of Beat This! final0 on P12-a signals and madmom 0.16.1's DBN
    # events for them (docs/dj/detector_comparison/dbn_probe.py: 62/62 equal).
    data = np.load(FIXTURES / 'beat_this_final0_dbn.npz')
    beats, firsts = dbn.beats_and_downbeats(data[f'{case}_beat'], data[f'{case}_downbeat'])
    assert len(beats) == len(data[f'{case}_expected_beats'])
    np.testing.assert_allclose(beats, data[f'{case}_expected_beats'], rtol=0, atol=1e-9)
    np.testing.assert_allclose(firsts, data[f'{case}_expected_firsts'], rtol=0, atol=1e-9)


def test_numpy_log_mel_matches_torchaudio():
    rate = 22050
    t = np.arange(3 * rate) / rate
    signal = (0.3 * np.sin(2 * np.pi * (110 * t + 400 * t * t))
              + 0.5 * (np.mod(t, 0.5) < 0.004) * np.sin(2 * np.pi * 2000 * t)).astype(np.float32)
    reference = np.load(FIXTURES / 'beat_this_log_mel.npz')['log_mel']  # torchaudio, PyTorch 2.5.1.
    np.testing.assert_allclose(beat_model.log_mel(signal), reference, rtol=0, atol=5e-4)


class _IndexSession:
    """Echoes column 0 of each chunk: the frame index, or 0 in padding."""
    def run(self, _outputs, feeds):
        piece = feeds['spect']
        return piece[..., 0], piece[..., 0]


@pytest.mark.parametrize('frames', [100, 1488, 1489, 1501, 4000])
def test_chunked_prediction_gives_every_frame_its_own_output(frames):
    spect = np.zeros((frames, 128), dtype=np.float32)
    spect[:, 0] = np.arange(frames)
    beat, first = beat_model.logits(_IndexSession(), spect)
    assert np.array_equal(beat, np.arange(frames)) and np.array_equal(first, beat)


def _click_track(seconds=40.0, bpm=123.0, rate=22050):
    samples = np.zeros(int(seconds * rate), dtype=np.float32)
    t = np.arange(int(.12 * rate)) / rate
    kick = np.sin(2 * np.pi * (55 * t + 2 * (1 - np.exp(-t / .03)))) * np.exp(-t / .06)
    onsets = np.arange(.4, seconds - .5, 60 / bpm)
    for index, at in enumerate(onsets):
        start = int(round(at * rate))
        samples[start:start + kick.size] += kick * (1. if index % 4 == 0 else .7)
    return samples, onsets


def test_real_model_finds_the_beats_of_a_synthetic_song(tmp_path):
    import wave
    from test_dj_beat_grid import song

    session = weights.session()
    assert session is not None, 'run scripts/fetch_dj_model.py'
    onsets, _ = song(tmp_path / 'song.wav', 123.0, seconds=40.0)  # Kick, hi-hat and chords at 22050 Hz.
    with wave.open(str(tmp_path / 'song.wav')) as source:
        samples = np.frombuffer(source.readframes(source.getnframes()), dtype='<i2').astype(np.float32) / 32768
    beats, _ = beat_model.events(session, samples)
    inner = onsets[2:-2]
    nearest = np.array([np.min(np.abs(beats - t)) for t in inner])
    # Between frames, before the attack alignment of `rhythm`: within a frame.
    assert np.percentile(nearest, 90) < 0.02
    assert len(beats) == pytest.approx(len(onsets), abs=3)


def test_onnx_runtime_telemetry_never_starts(tmp_path):
    # ONNX Runtime's Linux build carries Microsoft 1DS telemetry, which writes
    # a device id and event store under ~/.cache/Microsoft before uploading.
    code = ('import numpy as np\n'
            'from shared.dj import weights\n'
            's = weights.session()\n'
            "s.run(None, {'spect': np.zeros((1, 300, 128), np.float32)})\n")
    env = {key: value for key, value in os.environ.items() if key != 'ORT_DISABLE_TELEMETRY'}
    # Another HOME hides user site-packages (pip install --user): the child
    # imports from the same paths as this process.
    env.update(HOME=str(tmp_path), XDG_CACHE_HOME=str(tmp_path / 'xdg'),
               SOUNDSIBLE_BEAT_MODEL=str(weights.model_path(download=False)),
               PYTHONPATH=os.pathsep.join([str(Path(__file__).resolve().parents[1]), *filter(None, sys.path)]))
    subprocess.run([sys.executable, '-c', code], env=env, check=True, cwd=tmp_path)
    assert not (tmp_path / '.cache' / 'Microsoft').exists()
    assert not (tmp_path / 'xdg' / 'Microsoft').exists()


def test_weights_are_used_only_with_their_checksum(tmp_path, monkeypatch):
    wrong = tmp_path / weights.MODEL_FILE
    wrong.write_bytes(b'\0' * 1024)
    monkeypatch.setenv(weights.ENVIRONMENT, str(wrong))
    assert weights.model_path() is None  # An explicit path never falls back to a download.
    truncated = tmp_path / 'truncated.onnx'
    source = weights.bundled_path()
    if not weights._verified_file(source):
        pytest.skip('run scripts/fetch_dj_model.py')
    truncated.write_bytes(source.read_bytes()[:-1] + b'\1')
    monkeypatch.setenv(weights.ENVIRONMENT, str(truncated))
    assert weights.model_path() is None
    monkeypatch.setenv(weights.ENVIRONMENT, str(source))
    assert weights.model_path() == source


def test_analysis_without_the_model_is_not_cached(tmp_path, monkeypatch):
    import wave
    from shared.dj import store

    monkeypatch.setattr(store, '_cache_path', lambda: tmp_path / 'analysis.sqlite3')
    monkeypatch.setattr(weights, 'session', lambda: None)
    samples, _ = _click_track(seconds=10)
    path = tmp_path / 'kicks.wav'
    with wave.open(str(path), 'wb') as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(22050)
        output.writeframes((samples * 16000).astype('<i2').tobytes())
    analysis = store.analyse_audio(path, 'kicks', duration_hint=10)
    assert analysis['analysed'] is False
    assert store.cached_analysis(path, 'kicks') is None
