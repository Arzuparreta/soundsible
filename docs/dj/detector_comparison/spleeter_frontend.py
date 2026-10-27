"""Isolated TensorFlow frontend for the Beat Transformer experimental variant.

Uses the authors' working public Colab frontend with Spleeter 2.3.2. The
repository's separate preprocessing script contains a dict.append error.
Execution on CPU and the common mono input are explicit benchmark choices.
"""
import json
import importlib.metadata
import os
from pathlib import Path
import resource
import sys
import time
import traceback

os.environ['CUDA_VISIBLE_DEVICES'] = '-1'
os.environ['TF_NUM_INTRAOP_THREADS'] = '1'
os.environ['TF_NUM_INTEROP_THREADS'] = '1'

START_WALL, START_CPU = time.perf_counter(), time.process_time()

import librosa
import numpy as np
from spleeter.audio.adapter import AudioAdapter
from spleeter.separator import Separator


def process(separator, mel, audio_path, target):
    wall, cpu = time.perf_counter(), time.process_time()
    child = resource.getrusage(resource.RUSAGE_CHILDREN)
    audio, _ = AudioAdapter.default().load(str(audio_path), sample_rate=44100)
    stems = separator.separate(audio)
    if not hasattr(separator, '_stft'):
        raise RuntimeError('The frozen Colab frontend requires Spleeter 2.3.2 _stft')
    spectrograms = []
    for name in stems:
        # Exact frontend from the authors' public Colab (Spleeter 2.3.2).
        spectrum = np.mean(separator._stft(stems[name]), axis=-1).T
        # Same per-stem dB normalization as dataset_processing.__getitem__.
        spectrograms.append(librosa.power_to_db(mel @ (np.abs(spectrum)**2), ref=np.max).T)
    np.save(target, np.stack(spectrograms).astype(np.float32))
    after = resource.getrusage(resource.RUSAGE_CHILDREN)
    cost = dict(wall_seconds=time.perf_counter()-wall,
        cpu_seconds=time.process_time()-cpu+after.ru_utime+after.ru_stime-child.ru_utime-child.ru_stime,
        peak_rss_kib=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)
    target.with_suffix('.cost.json').write_text(json.dumps(cost))
    return cost


def main():
    if importlib.metadata.version('spleeter') != '2.3.2':
        raise RuntimeError('Use the frozen Spleeter 2.3.2 environment for this frontend')
    separator = Separator('spleeter:5stems', multiprocess=False)
    mel = librosa.filters.mel(sr=44100, n_fft=4096, n_mels=128, fmin=30, fmax=11000)
    if sys.argv[1:] == ['--worker']:
        print('DJ_RESULT '+json.dumps(dict(ready=True, startup_wall_seconds=time.perf_counter()-START_WALL,
                                           startup_cpu_seconds=time.process_time()-START_CPU)), flush=True)
        for line in sys.stdin:
            try:
                request = json.loads(line)
                cost = process(separator, mel, Path(request['audio']), Path(request['target']))
                print('DJ_RESULT '+json.dumps(cost), flush=True)
            except Exception:
                print('DJ_RESULT '+json.dumps(dict(error=traceback.format_exc())), flush=True)
    else:
        process(separator, mel, Path(sys.argv[1]), Path(sys.argv[2]))


if __name__ == '__main__':
    main()
