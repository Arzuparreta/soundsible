"""Thin experimental adapters. Musical output remains attributable to upstream."""
from __future__ import annotations

import importlib
import sys
from pathlib import Path

import numpy as np

from .common import load_snapshot, result


class Backend:
    def __init__(self, method, root):
        self.method, self.root = method, Path(root)
        self.call = self._load(method)

    def __call__(self, audio):
        return self.call(audio)

    def _load(self, method):
        if method in ['soundsible-main', 'soundsible-p12', 'joint', 'joint-dbn']:
            rev = '8f520a797c3470c1e2a53d86673ef6694dd3105c' if method == 'soundsible-main' else '2ca8ccf2'
            name = '_p12_experimental_snapshot'
            load_snapshot(self.root/'snapshots'/rev, name)
            if method.startswith('joint'):
                from .joint import infer, infer_dbn
                implementation = infer_dbn if method == 'joint-dbn' else infer
                return lambda a: implementation(a.samples(11025), 11025, name)
            compose = importlib.import_module(name+'.analysis')._compose
            def baseline(audio):
                samples = audio.samples(11025)
                analysis = compose(samples, samples, 11025, duration=len(samples)/11025, tail_start=0)
                return result(analysis['beat_grid'], analysis['downbeats'], duration=audio.case['duration'],
                              regions=analysis.get('metric_regions'), native_analysis=analysis)
            return baseline
        if method.startswith('beatthis-'):
            from beat_this.inference import Audio2Frames
            from beat_this.model.postprocessor import Postprocessor
            checkpoint, decoding = method.split('-')[1:]
            path = self.root/'checkpoints'/(checkpoint+'.ckpt')
            if not path.exists():
                path = Path.home()/'.cache/torch/hub/checkpoints'/('beat_this-'+checkpoint+'.ckpt')
            model = Audio2Frames(str(path), device='cpu')
            post = Postprocessor(type='dbn' if decoding == 'dbn' else 'minimal')
            def beatthis(audio):
                beat, downbeat = model(audio.samples(22050), 22050)
                logits = dict(beat=beat, downbeat=downbeat)
                beats, bars = post(logits['beat'], logits['downbeat'])
                return result(beats, bars, duration=audio.case['duration'],
                              activations={k: v.detach().cpu().numpy() for k, v in logits.items()}, activation_kind='logits_50fps')
            return beatthis
        if method.startswith('madmom-'):
            from madmom.features.downbeats import RNNDownBeatProcessor, DBNDownBeatTrackingProcessor
            rnn = RNNDownBeatProcessor()
            groups = [2, 3, 4, 6] if method.endswith('extended') else [3, 4]
            decoder = DBNDownBeatTrackingProcessor(beats_per_bar=groups, fps=100, num_threads=1)
            def madmom(audio):
                from madmom.audio.signal import Signal
                activation = rnn(Signal(audio.samples(44100), sample_rate=44100))
                events = decoder(activation)
                return result(events[:, 0], events[events[:, 1] == 1, 0], duration=audio.case['duration'],
                              activations=activation, activation_kind='native_probability_100fps')
            return madmom
        if method.startswith('beatnet-'):
            from BeatNet.BeatNet import BeatNet
            model, decoding = method.split('-')[1:]
            mode = 'offline' if decoding == 'dbn' else 'online'
            tracker = BeatNet(int(model), mode=mode, inference_model=decoding.upper(), plot=[], thread=False, device='cpu')
            def beatnet(audio):
                tracker.model.hidden.zero_()
                tracker.model.cell.zero_()
                np.random.seed(1804)
                # Reinstantiate the stateful PF for each independent recording.
                if decoding == 'pf':
                    from BeatNet.particle_filtering_cascade import particle_filter_cascade
                    import BeatNet.particle_filtering_cascade as pf
                    pf.rng = np.random.default_rng(1804)
                    tracker.estimator = particle_filter_cascade(beats_per_bar=[], fps=50, plot=[], mode='online')
                activation = tracker.activation_extractor_online(audio.samples(22050))
                rows = tracker.estimator(activation) if decoding == 'dbn' else tracker.estimator.process(activation)
                rows = np.asarray(rows).reshape(-1, 2)
                return result(rows[:, 0], rows[rows[:, 1] == 1, 0], duration=audio.case['duration'],
                              activations=activation, activation_kind='native_probability_50fps')
            return beatnet
        if method.startswith('essentia-'):
            import essentia.standard as es
            tracker = es.RhythmExtractor2013(method=method.split('-')[1])
            def essentia(audio):
                bpm, beats, confidence, _, _ = tracker(audio.samples(44100))
                return result(beats, duration=audio.case['duration'],
                              native_bpm=float(bpm) if np.isfinite(bpm) else None,
                              native_confidence=float(confidence) if method.endswith('multifeature') and np.isfinite(confidence) else None,
                              native_confidence_raw=float(confidence) if np.isfinite(confidence) else None,
                              downbeat_capability=False)
            return essentia
        if method.startswith('librosa-'):
            import librosa
            def librosa_control(audio):
                samples = audio.samples(22050)
                envelope = librosa.onset.onset_strength(y=samples, sr=22050, hop_length=512)
                bpm = None
                if method.endswith('local'):
                    bpm = librosa.feature.tempo(onset_envelope=envelope, sr=22050, hop_length=512, aggregate=None)
                _, frames = librosa.beat.beat_track(onset_envelope=envelope, sr=22050, hop_length=512, bpm=bpm)
                beats = librosa.frames_to_time(frames, sr=22050, hop_length=512)
                return result(beats, duration=audio.case['duration'], downbeat_capability=False)
            return librosa_control
        if method.startswith('allin1-'):
            from .separated import allin1
            return allin1(method, self.root)
        if method.startswith('beatnetplus-'):
            sys.path.insert(0, str(self.root/'sources/mjhydri_BeatNet-Plus/src'))
            from BeatNetPlus.inference import BeatNetPlusInference
            model_name, decoding = method.split('-')[1:]
            filename = {'generic': 'generic_weights.pt', 'main': 'generic_main_weights.pt',
                        'nonpercussive': 'af_non_percussive_weights.pt'}[model_name]
            source = self.root/'sources/mjhydri_BeatNet-Plus/src/BeatNetPlus'
            tracker = BeatNetPlusInference(str(source/'models'/filename), mode='offline' if decoding == 'dbn' else 'online',
                                          inference_model=decoding.upper(), plot=[], device='cpu')
            def beatnetplus(audio):
                tracker.model.reset_hidden()
                np.random.seed(1804)
                if decoding == 'pf':
                    from BeatNetPlus.particle_filtering_cascade import particle_filter_cascade
                    import BeatNetPlus.particle_filtering_cascade as pf
                    pf.rng = np.random.default_rng(1804)
                    tracker.estimator = particle_filter_cascade(beats_per_bar=[], fps=50, plot=[], mode='online')
                feats = tracker.proc.process_audio(audio.samples(22050)).T
                activation = tracker._get_activations(feats)
                rows = tracker.estimator(activation) if decoding == 'dbn' else tracker.estimator.process(activation)
                rows = np.asarray(rows).reshape(-1, 2)
                return result(rows[:, 0], rows[rows[:, 1] == 1, 0], duration=audio.case['duration'],
                              activations=activation, activation_kind='native_probability_50fps')
            return beatnetplus
        if method.startswith('transformer-'):
            from .separated import transformer
            return transformer(method, self.root)
        raise ValueError('Unknown method: '+method)
