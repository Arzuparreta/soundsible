"""Beat This! without PyTorch at inference: ONNX export and a NumPy frontend.

Evidence for the runtime choice, not a new detector. Two steps, two environments:

  export  (lab Python with torch + beat_this): write one ONNX file per checkpoint
          and compare the NumPy frontend with upstream LogMelSpect.
  run     (clean Python with only numpy + onnxruntime): recompute the logits of
          every manifest case from the cached 22050 Hz soxr derivative, using the
          upstream chunking, and compare them with the retained `-direct` logits
          and events measured by the benchmark. One ORT thread; CPU per minute.

The comparison does not rerun PyTorch: the reference is what the benchmark
already recorded, so a match shows the torch-free path reproduces it.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import platform
import resource
import time
from pathlib import Path

import numpy as np

FPS = 50
CHUNK, BORDER = 1500, 6
SAMPLE_RATE, N_FFT, HOP, F_MIN, F_MAX, N_MELS = 22050, 1024, 441, 30., 11000., 128


def _hz_to_mel(f):
    # Slaney scale, as torchaudio's melscale_fbanks(mel_scale="slaney").
    f = np.asarray(f, dtype=np.float64)
    mel = f / (200. / 3)
    log = f >= 1000.
    return np.where(log, 15. + np.log(np.maximum(f, 1e-12) / 1000.) / (np.log(6.4) / 27.), mel)


def _mel_to_hz(m):
    m = np.asarray(m, dtype=np.float64)
    f = m * (200. / 3)
    log = m >= 15.
    return np.where(log, 1000. * np.exp((np.log(6.4) / 27.) * (m - 15.)), f)


def mel_filterbank():
    freqs = np.linspace(0, SAMPLE_RATE // 2, N_FFT // 2 + 1)
    points = _mel_to_hz(np.linspace(_hz_to_mel(F_MIN), _hz_to_mel(F_MAX), N_MELS + 2))
    diff = points[1:] - points[:-1]
    slopes = points[None, :] - freqs[:, None]
    down = -slopes[:, :-2] / diff[:-1]
    up = slopes[:, 2:] / diff[1:]
    return np.maximum(0., np.minimum(down, up))  # (freqs, mels), norm=None


def log_mel(signal):
    """NumPy LogMelSpect: centred reflect-padded periodic-Hann STFT, magnitude
    scaled by 1/sqrt(n_fft) (torch.stft normalized=True, which torchaudio uses
    for "frame_length"), Slaney mel, log1p(1000·x)."""
    signal = np.asarray(signal, dtype=np.float32)
    window = (0.5 - 0.5 * np.cos(2 * np.pi * np.arange(N_FFT) / N_FFT)).astype(np.float32)
    padded = np.pad(signal, N_FFT // 2, mode='reflect')
    count = 1 + (len(padded) - N_FFT) // HOP
    frames = np.lib.stride_tricks.as_strided(
        padded, shape=(count, N_FFT), strides=(padded.strides[0] * HOP, padded.strides[0]))
    spectrum = np.abs(np.fft.rfft(frames * window, axis=1)) / np.sqrt(N_FFT)
    return np.log1p(1000. * (spectrum @ mel_filterbank())).astype(np.float32)


def predict(session, spect):
    """Upstream split_piece/aggregate_prediction with keep_first overlap."""
    size = len(spect)
    starts = np.arange(-BORDER, size - BORDER, CHUNK - 2 * BORDER)
    if size > CHUNK - 2 * BORDER:
        starts[-1] = size - (CHUNK - BORDER)
    beat = np.full(size, -1000., dtype=np.float32)
    downbeat = np.full(size, -1000., dtype=np.float32)
    for start in reversed(starts):  # keep_first: earlier chunks overwrite later ones
        piece = spect[max(start, 0):min(start + CHUNK, size)]
        left, right = max(0, -start), max(0, min(BORDER, start + CHUNK - size))
        piece = np.pad(piece, ((left, right), (0, 0)))
        out_beat, out_downbeat = session.run(None, {'spect': piece[None]})
        span = slice(start + BORDER, start + CHUNK - BORDER)
        width = len(beat[span])
        beat[span] = out_beat[0][BORDER:-BORDER][:width]
        downbeat[span] = out_downbeat[0][BORDER:-BORDER][:width]
    return beat, downbeat


def _deduplicate(peaks):
    result, peaks = [], [int(p) for p in peaks]
    if not peaks:
        return np.array(result)
    p, c = peaks[0], 1
    for p2 in peaks[1:]:
        if p2 - p <= 1:
            c += 1
            p += (p2 - p) / c
        else:
            result.append(p)
            p, c = p2, 1
    result.append(p)
    return np.array(result)


def minimal(beat, downbeat):
    """Upstream "minimal" postprocessor: ±3-frame maxima with logit > 0."""
    def peaks(logits):
        padded = np.pad(logits, 3, constant_values=-np.inf)
        local = np.lib.stride_tricks.sliding_window_view(padded, 7).max(axis=1)
        return _deduplicate(np.nonzero((logits == local) & (logits > 0))[0])
    beats, downbeats = peaks(beat) / FPS, peaks(downbeat) / FPS
    if len(beats):
        downbeats = np.array([beats[np.argmin(np.abs(beats - d))] for d in downbeats])
    return beats, np.unique(downbeats)


def export(args):
    import torch
    from beat_this.inference import load_model
    from beat_this.preprocessing import LogMelSpect

    torch.set_num_threads(1)
    if args.sliced_attention:
        # Same arithmetic, one T×T score matrix at a time: the frontend's
        # time-directed attention per frequency band (batch = bands ≤ 32) and
        # the main transformer per head (batch 1). The exported MatMul/Softmax
        # then hold one band's or head's scores instead of all of them.
        # Frequency-directed attention (batch = frames, sequence ≤ 32 bands)
        # keeps the upstream single call: its score matrices are small.
        from beat_this.model import roformer
        import torch.nn.functional as F

        def attend(self, q, k, v):
            if self.scale is not None:
                q = q * (self.scale / q.shape[-1] ** -0.5)
            if q.shape[0] == 1:
                return torch.cat([F.scaled_dot_product_attention(q[:, h:h + 1], k[:, h:h + 1], v[:, h:h + 1])
                                  for h in range(q.shape[1])], dim=1)
            if q.shape[0] > 64:
                return F.scaled_dot_product_attention(q, k, v)
            return torch.cat([F.scaled_dot_product_attention(q[i:i + 1], k[i:i + 1], v[i:i + 1])
                              for i in range(q.shape[0])], dim=0)
        roformer.Attend.forward = attend
    args.out.mkdir(parents=True, exist_ok=True)
    report = {'sliced_attention': args.sliced_attention}
    for name, path in args.checkpoint:
        model = load_model(str(path), 'cpu')

        class Logits(torch.nn.Module):
            def __init__(self):
                super().__init__()
                self.model = model

            def forward(self, spect):
                out = self.model(spect)
                return out['beat'], out['downbeat']

        target = args.out / f'beat_this-{name}.onnx'
        with torch.inference_mode():
            torch.onnx.export(Logits().eval(), (torch.zeros(1, CHUNK, N_MELS),), str(target),
                              input_names=['spect'], output_names=['beat', 'downbeat'],
                              dynamic_axes={'spect': {1: 'frames'}, 'beat': {1: 'frames'}, 'downbeat': {1: 'frames'}},
                              opset_version=17, dynamo=False)
        report[name] = dict(checkpoint_sha256=hashlib.sha256(Path(path).read_bytes()).hexdigest(),
                            onnx_sha256=hashlib.sha256(target.read_bytes()).hexdigest(),
                            onnx_bytes=target.stat().st_size, torch=torch.__version__, opset=17)
    # Frontend equality on real derivatives, independent of the network.
    upstream = LogMelSpect()
    frontend = []
    for path in sorted(args.derivatives.glob('*-mono-soxr-HQ-22050.npy'))[:args.frontend_cases]:
        signal = np.load(path).astype(np.float32)
        with torch.inference_mode():
            reference = upstream(torch.from_numpy(signal)).numpy()
        mine = log_mel(signal)
        frontend.append(dict(derivative=path.name, frames=len(mine), same_shape=mine.shape == reference.shape,
                             max_abs_difference=float(np.max(np.abs(mine - reference))),
                             reference_max=float(np.max(reference))))
    report['frontend'] = frontend
    (args.out / 'export.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))


def _match(a, b, tolerance=1e-6):
    a, b = np.asarray(a, float), np.asarray(b, float)
    return len(a) == len(b) and bool(np.all(np.abs(a - b) <= tolerance))


def run(args):
    import onnxruntime as ort

    options = ort.SessionOptions()
    options.intra_op_num_threads = options.inter_op_num_threads = 1
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    manifest = json.loads(args.manifest.read_text())
    report = dict(onnxruntime=ort.__version__, numpy=np.__version__, python=platform.python_version(),
                  machine=platform.machine(), methods={})
    for name in args.models:
        start_cpu = time.process_time()
        session = ort.InferenceSession(str(args.onnx / f'beat_this-{name}.onnx'), options,
                                       providers=['CPUExecutionProvider'])
        load_cpu = time.process_time() - start_cpu
        reference_dir = args.results / f'beatthis-{name}-direct'
        rows = []
        for case in manifest['cases']:
            stored = reference_dir / f"{case['id']}.npz"
            if not stored.exists():
                continue
            identity = hashlib.sha256(Path(case['file']).read_bytes()).hexdigest()
            signal = np.load(args.derivatives / f'{identity}-mono-soxr-HQ-22050.npy')
            timings = []
            for _ in range(2):
                cpu = time.process_time()
                spect = log_mel(signal)
                frontend_cpu = time.process_time() - cpu
                beat, downbeat = predict(session, spect)
                timings.append(dict(frontend_cpu_seconds=frontend_cpu, total_cpu_seconds=time.process_time() - cpu))
            retained = np.load(stored)
            events = json.loads(stored.with_suffix('.json').read_text())['raw']
            beats, downbeats = minimal(beat, downbeat)
            minutes = len(signal) / SAMPLE_RATE / 60
            rows.append(dict(case=case['id'], dataset=case['dataset'], frames=len(beat),
                             beat_logit_max_abs_difference=float(np.max(np.abs(beat - retained['beat']))),
                             downbeat_logit_max_abs_difference=float(np.max(np.abs(downbeat - retained['downbeat']))),
                             same_beats=_match(beats, events['beats']),
                             same_downbeats=_match(downbeats, events['downbeats']),
                             cpu_seconds_per_audio_minute=min(t['total_cpu_seconds'] for t in timings) / minutes,
                             frontend_cpu_seconds_per_audio_minute=min(t['frontend_cpu_seconds'] for t in timings) / minutes))
        report['methods'][name] = dict(
            session_load_cpu_seconds=load_cpu, cases=len(rows),
            identical_event_cases=sum(r['same_beats'] and r['same_downbeats'] for r in rows),
            max_logit_abs_difference=max(max(r['beat_logit_max_abs_difference'], r['downbeat_logit_max_abs_difference'])
                                         for r in rows),
            median_cpu_seconds_per_audio_minute=float(np.median([r['cpu_seconds_per_audio_minute'] for r in rows])),
            median_frontend_cpu_seconds_per_audio_minute=float(np.median(
                [r['frontend_cpu_seconds_per_audio_minute'] for r in rows])),
            process_peak_rss_mib=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024, rows=rows)
    args.output.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({k: {m: v for m, v in d.items() if m != 'rows'} if isinstance(d, dict) else d
                      for k, d in report['methods'].items()}, indent=2))


def memory(args):
    """Peak RSS of one fresh process analysing one derivative, after loading.

    ONNX Runtime by default; `--checkpoint` measures upstream PyTorch instead.
    Run once per configuration: ru_maxrss never decreases within a process.
    """
    signal = np.load(args.derivative).astype(np.float32)
    if args.checkpoint:
        import torch
        from beat_this.inference import Spect2Frames
        from beat_this.preprocessing import LogMelSpect

        torch.set_num_threads(1)
        model = Spect2Frames(str(args.checkpoint), 'cpu')
        loaded = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024
        cpu = time.process_time()
        with torch.inference_mode():
            model(LogMelSpect()(torch.from_numpy(signal)))
        runtime = f'torch {torch.__version__}'
    else:
        import onnxruntime as ort

        options = ort.SessionOptions()
        options.intra_op_num_threads = options.inter_op_num_threads = 1
        if args.no_arena:
            options.enable_cpu_mem_arena = options.enable_mem_pattern = False
        session = ort.InferenceSession(str(args.onnx), options, providers=['CPUExecutionProvider'])
        loaded = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024
        cpu = time.process_time()
        predict(session, log_mel(signal))
        runtime = f'onnxruntime {ort.__version__}' + (' without arena' if args.no_arena else '')
    minutes = len(signal) / SAMPLE_RATE / 60
    print(json.dumps(dict(model=str(args.checkpoint or args.onnx), runtime=runtime, audio_seconds=round(minutes * 60, 2),
                          rss_after_load_mib=round(loaded), peak_rss_mib=round(
                              resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024),
                          cpu_seconds_per_audio_minute=round((time.process_time() - cpu) / minutes, 3))))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='step', required=True)
    e = sub.add_parser('export')
    e.add_argument('--checkpoint', nargs=2, action='append', metavar=('NAME', 'PATH'), required=True)
    e.add_argument('--out', type=Path, required=True)
    e.add_argument('--derivatives', type=Path, required=True)
    e.add_argument('--frontend-cases', type=int, default=8)
    e.add_argument('--sliced-attention', action='store_true')
    r = sub.add_parser('run')
    r.add_argument('--onnx', type=Path, required=True)
    r.add_argument('--manifest', type=Path, required=True)
    r.add_argument('--derivatives', type=Path, required=True)
    r.add_argument('--results', type=Path, required=True)
    r.add_argument('--output', type=Path, required=True)
    r.add_argument('--models', nargs='+', default=['small0', 'final0'])
    m = sub.add_parser('memory')
    m.add_argument('--derivative', type=Path, required=True)
    source = m.add_mutually_exclusive_group(required=True)
    source.add_argument('--onnx', type=Path)
    source.add_argument('--checkpoint', type=Path)
    m.add_argument('--no-arena', action='store_true')
    args = parser.parse_args()
    {'export': export, 'run': run, 'memory': memory}[args.step](args)


if __name__ == '__main__':
    main()
