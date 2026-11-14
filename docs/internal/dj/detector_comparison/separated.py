"""Models with mandatory source separation, accounted as a separate stage."""
from __future__ import annotations

from dataclasses import asdict
import atexit
import hashlib
import json
from pathlib import Path
import random
import resource
import subprocess
import sys
import time
from unittest.mock import patch

import numpy as np

from .common import digest, result, write_json


def allin1(method, root):
    import torch
    import allin1.models.loaders as loaders
    from allin1.models import load_pretrained_model
    from allin1.spectrogram import extract_spectrograms
    from allin1.helpers import run_inference
    from demucs import separate as demucs_cli
    from demucs.pretrained import get_model
    model_name = 'harmonix-all' if method.endswith('-all') else 'harmonix-fold0'
    # The upstream wrapper does not expose a revision argument.
    revision = json.loads((root/'allin1-hf-metadata.json').read_text())['sha']
    def prepared_checkpoint(repo_id, filename, cache_dir=None):
        if repo_id != 'taejunkim/allinone':
            raise ValueError(repo_id)
        path = root/'checkpoints'/filename
        if not path.exists():
            raise FileNotFoundError(f'Prepare checkpoint {revision}/{filename} before measuring')
        return str(path)
    loaders.hf_hub_download = prepared_checkpoint
    model = load_pretrained_model(model_name, device='cpu')
    neural_cost = {}
    original_forward = model.forward
    def timed_forward(*args, **kwargs):
        start, cpu = time.perf_counter(), time.process_time()
        value = original_forward(*args, **kwargs)
        neural_cost.update(wall_seconds=time.perf_counter()-start, cpu_seconds=time.process_time()-cpu)
        return value
    model.forward = timed_forward
    demixer = get_model('htdemucs').cpu().eval()
    configuration = dict(demucs='4.0.1', name='htdemucs', shifts=1, seed=1804,
                         frontend='common mono float WAV 44100 Hz; upstream CLI with retained model',
                         spectrogram_source='allin1 18e78903c036',
                         checkpoint_sha256=digest(Path(torch.hub.get_dir())/'checkpoints/955717e8-8726e21a.th'))
    namespace = hashlib.sha256(json.dumps(configuration, sort_keys=True).encode()).hexdigest()[:16]
    def predict(audio):
        stage = root/'separated'/(audio.identity+'-'+namespace)
        stage.mkdir(parents=True, exist_ok=True)
        cost_path = stage/'allin1-cost.json'
        cached = cost_path.exists()
        start = time.perf_counter()
        cpu = time.process_time()
        child = resource.getrusage(resource.RUSAGE_CHILDREN)
        canonical = audio.wave(44100)
        directory = stage/'demix/htdemucs'/canonical.stem
        if not all((directory/(name+'.wav')).exists() for name in ['bass', 'drums', 'other', 'vocals']):
            random.seed(1804)
            torch.manual_seed(1804)
            # The original CLI body performs normalization, apply_model and
            # saving unchanged. Only repeated model loading is avoided.
            with patch.object(demucs_cli, 'get_model_from_args', return_value=demixer):
                demucs_cli.main(['--out', str(stage/'demix'), '--name', 'htdemucs',
                                 '--device', 'cpu', str(canonical)])
        paths = [directory]
        spec = extract_spectrograms(paths, stage/'spec', multiprocess=False)
        if not cost_path.exists():
            after = resource.getrusage(resource.RUSAGE_CHILDREN)
            write_json(cost_path, dict(wall_seconds=time.perf_counter()-start,
                                       cpu_seconds=time.process_time()-cpu+after.ru_utime+after.ru_stime-child.ru_utime-child.ru_stime))
        start, cpu = time.perf_counter(), time.process_time()
        with torch.inference_mode():
            prediction = run_inference(audio.path, spec[0], model, device='cpu',
                                       include_activations=True, include_embeddings=False)
        return result(prediction.beats, prediction.downbeats, duration=audio.case['duration'],
                      activations=prediction.activations, activation_kind='native_probability_100fps',
                      structure_segments=[asdict(s) for s in prediction.segments],
                      preprocessing_cost=json.loads(cost_path.read_text()),
                      preprocessing_configuration=configuration,
                      native_inference_wall_seconds=time.perf_counter()-start,
                      native_inference_cpu_seconds=time.process_time()-cpu,
                      neural_forward_cost=dict(neural_cost),
                      separation_cache_hit=cached)
    return predict


def transformer(method, root):
    import torch
    from madmom.features.beats import DBNBeatTrackingProcessor
    from madmom.features.downbeats import DBNDownBeatTrackingProcessor
    source = root/'sources/zhaojw1998_Beat-Transformer'
    sys.path.insert(0, str(source/'code'))
    from DilatedTransformer import Demixed_DilatedTransformerModel
    model = Demixed_DilatedTransformerModel(attn_len=5, instr=5, ntoken=2, dmodel=256,
                                           nhead=8, d_hid=1024, nlayers=9, norm_first=True)
    model.load_state_dict(torch.load(source/'checkpoint/fold_0_trf_param.pt', map_location='cpu', weights_only=True)['state_dict'])
    model.eval()
    decoder = DBNDownBeatTrackingProcessor(beats_per_bar=[3, 4], min_bpm=55., max_bpm=215.,
                                          fps=44100/1024, transition_lambda=100,
                                          observation_lambda=6, num_tempi=None, threshold=.2, num_threads=1)
    beat_decoder = DBNBeatTrackingProcessor(min_bpm=55., max_bpm=215., fps=44100/1024,
                                           transition_lambda=100, observation_lambda=6,
                                           num_tempi=None, threshold=.2)
    worker = subprocess.Popen([str(root/'spleeter232-venv/bin/python'),
                               str(Path(__file__).with_name('spleeter_frontend.py')), '--worker'],
                              stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, cwd=root)
    def message():
        while True:
            line = worker.stdout.readline()
            if not line:
                raise RuntimeError(f'Spleeter worker exited: {worker.poll()}')
            if line.startswith('DJ_RESULT '):
                return json.loads(line[len('DJ_RESULT '):])
    def close():
        if worker.poll() is None:
            worker.stdin.close()
            try:
                worker.wait(timeout=15)
            except subprocess.TimeoutExpired:
                worker.kill()
                worker.wait()
    atexit.register(close)
    try:
        ready = message()
    except BaseException:
        worker.kill()
        worker.wait()
        raise
    if not ready.get('ready'):
        close()
        raise RuntimeError(ready)
    configuration = dict(spleeter='2.3.2', tensorflow='2.11.1', librosa='0.8.1',
                         stems=5, frame_length=4096, hop=1024, mel=128,
                         frontend='official Colab STFT; common mono float WAV 44100 Hz; persistent worker',
                         checkpoint_sha256=digest(root/'pretrained_models/5stems/model.data-00000-of-00001'))
    namespace = hashlib.sha256(json.dumps(configuration, sort_keys=True).encode()).hexdigest()[:16]
    def predict(audio):
        stage = root/'separated'/(audio.identity+'-'+namespace)
        stage.mkdir(parents=True, exist_ok=True)
        spec_path = stage/'spleeter232-mel128.npy'
        cached = spec_path.exists()
        active_child_cpu = 0.
        if not spec_path.exists():
            start = time.perf_counter()
            parent_cpu = time.process_time()
            worker.stdin.write(json.dumps(dict(audio=str(audio.wave(44100)), target=str(spec_path)))+'\n')
            worker.stdin.flush()
            try:
                response = message()
            except BaseException:
                worker.kill()
                worker.wait()
                raise
            if response.get('error'):
                raise RuntimeError(response['error'])
            active_child_cpu = response['cpu_seconds']
            write_json(spec_path.with_suffix('.cost.json'), dict(wall_seconds=time.perf_counter()-start,
                       cpu_seconds=active_child_cpu+time.process_time()-parent_cpu,
                       peak_rss_kib=response['peak_rss_kib']))
        # Preprocessing is measured when first computed; repeated inference
        # reuses exactly those bytes and reports its cost separately.
        values = np.load(spec_path)
        start, cpu = time.perf_counter(), time.process_time()
        with torch.inference_mode():
            logits, _ = model(torch.from_numpy(values).unsqueeze(0))
            activation = logits[0].sigmoid().numpy()
        combined = np.column_stack([np.maximum(activation[:, 0]-activation[:, 1], 0), activation[:, 1]])
        points = decoder(combined)
        return result(beat_decoder(activation[:, 0]), points[points[:, 1] == 1, 0], duration=audio.case['duration'],
                      activations=activation, activation_kind='native_probability_43.066fps',
                      preprocessing_cost=json.loads(spec_path.with_suffix('.cost.json').read_text()),
                      preprocessing_configuration=configuration, active_child_cpu_seconds=active_child_cpu,
                      frontend_variant='Official Colab frontend, Spleeter 2.3.2; CPU instead of CUDA',
                      native_inference_wall_seconds=time.perf_counter()-start,
                      native_inference_cpu_seconds=time.process_time()-cpu,
                      separation_cache_hit=cached)
    predict.load_child_cpu_seconds = ready['startup_cpu_seconds']
    return predict
