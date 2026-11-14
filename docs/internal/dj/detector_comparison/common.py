"""Explicit seconds, native absences, and reproducible input derivatives."""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np


def scratch(root):
    """Keep child-process and Python temporaries beside the experiment data."""
    directory = (Path(root)/'temporary').resolve()
    directory.mkdir(parents=True, exist_ok=True)
    if shutil.disk_usage(directory).free < 1024**3:
        raise OSError(f'Less than 1 GiB available for experiment scratch: {directory}')
    os.environ['TMPDIR'] = str(directory)
    tempfile.tempdir = str(directory)
    return directory


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value, indent=2, allow_nan=False) + '\n')
    temporary.replace(path)


def load_snapshot(directory, name):
    directory = Path(directory)
    # Absolute imports used by the snapshots resolve only supporting engine code.
    sys.path.insert(0, str(directory))
    spec = importlib.util.spec_from_file_location(name, directory/'shared/dj/__init__.py',
                                                submodule_search_locations=[str(directory/'shared/dj')])
    package = importlib.util.module_from_spec(spec)
    sys.modules[name] = package
    spec.loader.exec_module(package)
    return package


def result(beats, downbeats=(), *, duration, regions=None, **extra):
    beats = np.asarray(beats, dtype=float)
    downbeats = np.asarray(downbeats, dtype=float)
    for array in (beats, downbeats):
        if array.ndim != 1 or not np.all(np.isfinite(array)) or np.any(np.diff(array) <= 0):
            raise ValueError('Events must be finite and strictly increasing')
        if np.any(array < 0) or np.any(array > duration + .1):
            raise ValueError('Event outside decoded coverage')
    if regions is None:
        # Counts between model downbeats are derived output, not a time signature.
        regions = []
        for a, b in zip(downbeats[:-1], downbeats[1:]):
            local = beats[(beats >= a-.03) & (beats < b-.03)]
            size = len(local)
            if 2 <= size <= 12:
                regions.append(dict(start=float(a), end=float(b), beats_per_bar=size,
                                    period=float((b-a)/size), bar_seconds=float(b-a),
                                    subdivision=None, pulse_unit=None,
                                    pulse_confidence=None, metre_confidence=None,
                                    downbeat_confidence=None, subdivision_confidence=None,
                                    downbeats=[float(a)]))
    return dict(beats=beats.tolist(), downbeats=downbeats.tolist(), regions=regions,
                bpm=60/float(np.median(np.diff(beats))) if len(beats) > 1 else None,
                duration=duration, confidence_calibrated=False, **extra)


class Audio:
    """One lossless decode, then content-addressed format derivatives."""
    def __init__(self, case, cache):
        self.case = case
        self.cache = Path(cache)
        self.path = Path(case['file'])
        self.identity = digest(self.path)

    def samples(self, rate):
        import soundfile as sf
        import soxr
        target = self.cache / f'{self.identity}-mono-soxr-HQ-{rate}.npy'
        if not target.exists():
            decoded = self.cache / f'{self.identity}-decoded.npy'
            metadata = decoded.with_suffix('.json')
            if not decoded.exists():
                try:
                    data, native = sf.read(self.path, dtype='float32', always_2d=True)
                except sf.LibsndfileError:
                    probe = json.loads(subprocess.check_output([
                        'ffprobe', '-v', 'error', '-select_streams', 'a:0', '-show_entries',
                        'stream=sample_rate,channels', '-of', 'json', str(self.path)]))['streams'][0]
                    native = int(probe['sample_rate'])
                    payload = subprocess.check_output(['ffmpeg', '-v', 'error', '-threads', '1', '-i', str(self.path),
                                                       '-f', 'f32le', '-acodec', 'pcm_f32le', '-'])
                    data = np.frombuffer(payload, dtype='<f4').reshape(-1, int(probe['channels']))
                self.cache.mkdir(parents=True, exist_ok=True)
                np.save(decoded, np.mean(data, axis=1))
                write_json(metadata, dict(sample_rate=native))
            mono = np.load(decoded)
            native = json.loads(metadata.read_text())['sample_rate']
            if native != rate:
                mono = soxr.resample(mono, native, rate, quality='HQ')
            target.parent.mkdir(parents=True, exist_ok=True)
            np.save(target, mono.astype(np.float32))
        return np.load(target)

    def wave(self, rate=44100):
        """Lossless common mono input for file-only source-separation APIs."""
        import soundfile as sf
        target = self.cache/f'{self.identity}-mono-soxr-HQ-{rate}.wav'
        if not target.exists():
            sf.write(target, self.samples(rate), rate, subtype='FLOAT')
        return target
