#!/usr/bin/env python3
"""How far a song's pulse moves from one straight grid, measured without a beat tracker.

Behind docs/internal/dj/VERIFICATION.md. A second, independent reading of the
question `rhythm.py` answers with Beat This! beats: can one fixed playback rate
hold this song's pulse? It shares no code with the analyser: no beat model, no
beat times, no constants from `rhythm.py`.

Method. A band-wise onset envelope (24 log-spaced bands, 2.9 ms frames, each
frame compared with the one 11.6 ms earlier) is folded over one beat cycle at
the song's period into a mean pattern: every attack in the cycle counts, at
every harmonic, so off-beat hats do not cancel the beat. The pattern of each
16-beat stretch (hop 4 beats) is located against the pattern of the whole
window by circular cross-correlation. The stretch offsets are first chained to
the neighbouring stretch, then measured twice against the window's pattern
folded along that chain. A clarity-weighted straight line through the offsets
is the best fixed-rate grid; the distances from it are the result, in ms.

    # validation on synthetic drums with known beat times; with --analyser the
    # real analyser measures the same signals
    .venv/bin/python docs/internal/dj/pulse_straightness_probe.py synthetic --analyser

    # the library: aggregates only, no song identity
    .venv/bin/python docs/internal/dj/pulse_straightness_probe.py library \
        --analysis ~/.cache/soundsible/dj/analysis.sqlite3 --music <music dir> \
        --previews ~/.cache/soundsible/previews
"""
from __future__ import annotations

import argparse
from concurrent.futures import ProcessPoolExecutor
import json
import os
from pathlib import Path
import sqlite3
import statistics
import subprocess
import sys
import tempfile
import wave

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

SR = 22050
HOP = 64            # 2.9 ms frames
N_FFT = 1024
BANDS = 24
LAG = 4             # frames: an attack rises over 11.6 ms; noise does not keep rising
BINS = 128          # phase bins per beat cycle
STRETCH_BEATS, HOP_BEATS = 16, 4
SPAN_BEATS = 64     # a 16-bar overlap at four beats a bar
# The analyser's windows (shared/dj/store.py); songs up to 480 s are read whole.
WINDOWED_ABOVE, HEAD, TAIL = 480.0, 90.0, 120.0


def envelope(samples: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """(frame times in s, onset envelope)."""
    window = np.hanning(N_FFT).astype(np.float32)
    count = 1 + max(0, (samples.size - N_FFT) // HOP)
    freqs = np.fft.rfftfreq(N_FFT, 1 / SR)
    edges = np.geomspace(30, 11000, BANDS + 1)
    band = np.searchsorted(edges, freqs) - 1
    keep = (band >= 0) & (band < BANDS)
    level = np.empty((count, BANDS), np.float32)
    for start in range(0, count, 4096):
        rows = np.arange(start, min(count, start + 4096))
        frames = samples[np.arange(N_FFT)[None, :] + HOP * rows[:, None]] * window
        power = np.abs(np.fft.rfft(frames, axis=1)) ** 2
        summed = np.zeros((rows.size, BANDS))
        np.add.at(summed.T, band[keep], power[:, keep].T)
        level[rows] = np.log10(summed + 1e-6)
    flux = np.zeros(count, np.float32)
    flux[LAG:] = np.maximum(level[LAG:] - level[:-LAG], 0).sum(axis=1)
    flux -= np.convolve(flux, np.ones(129) / 129, mode='same')
    return (np.arange(count) * HOP + N_FFT / 2) / SR, np.maximum(flux, 0)


def refine_period(times, env, period: float) -> float:
    """The period within ±3 % whose beat-frequency component is strongest."""
    candidates = period * (1 + np.linspace(-0.03, 0.03, 601))
    strength = [abs((env * np.exp(-2j * np.pi * times / p)).sum()) for p in candidates]
    return float(candidates[int(np.argmax(strength))])


def _fold(times, env, period, shift=None):
    phase = (times - (shift(times) if shift is not None else 0.0)) / period
    bins = np.floor((phase % 1.0) * BINS).astype(int) % BINS
    return np.bincount(bins, weights=env, minlength=BINS) / np.maximum(np.bincount(bins, minlength=BINS), 1)


def _lag(local, template, period, limit):
    """Shift in s of `local` against `template` within ±limit, sub-bin, and their correlation."""
    local, template = local - local.mean(), template - template.mean()
    corr = np.fft.irfft(np.fft.rfft(local) * np.conj(np.fft.rfft(template)), BINS)
    lags = (np.arange(BINS) + BINS // 2) % BINS - BINS // 2
    allowed = np.flatnonzero(np.abs(lags) <= limit / period * BINS)
    k = int(allowed[np.argmax(corr[allowed])])
    a, b, c = corr[k - 1], corr[k], corr[(k + 1) % BINS]
    curve = a - 2 * b + c
    frac = 0.5 * (a - c) / curve if curve != 0 else 0.0
    norm = np.sqrt((local ** 2).sum() * (template ** 2).sum())
    return (lags[k] + frac) / BINS * period, (b / norm if norm > 0 else 0.0)


def local_offsets(times, env, period, rounds=2):
    """Rows of (stretch centre s, pattern offset s, clarity 0–1)."""
    span = STRETCH_BEATS * period
    starts = np.arange(times[0], times[-1] - span, HOP_BEATS * period)
    if starts.size < 2:
        return np.zeros((0, 3))
    centres = starts + span / 2
    selections = [(times >= t) & (times < t + span) for t in starts]
    plain = [_fold(times[s], env[s], period) for s in selections]
    offsets = [0.0]
    for k in range(1, len(plain)):
        offsets.append(offsets[-1] + _lag(plain[k], plain[k - 1], period, period / 4)[0])
    offsets = np.array(offsets)
    clarity = np.zeros_like(offsets)
    for _ in range(rounds):
        def shift(x, c=centres, o=offsets.copy()):
            return np.interp(x, c, o)
        template = _fold(times, env, period, shift)
        found = [_lag(_fold(times[s], env[s], period, shift), template, period, period / 4) for s in selections]
        offsets = offsets + np.array([lag for lag, _ in found])
        clarity = np.array([max(0.0, r) for _, r in found])
    return np.column_stack([centres, offsets, clarity])


def _line_residuals(centres, offsets, clarity):
    weights = clarity.copy()
    design = np.vstack([np.ones_like(centres), centres]).T
    for _ in range(3):  # weighted line, then Tukey down-weighting of outliers
        root = np.sqrt(weights)
        coef, *_ = np.linalg.lstsq(design * root[:, None], offsets * root, rcond=None)
        residual = offsets - design @ coef
        scale = max(0.002, 1.4826 * float(np.median(np.abs(residual))))
        u = residual / (4.685 * scale)
        weights = clarity * np.where(np.abs(u) < 1, (1 - u ** 2) ** 2, 0)
    return residual


def straightness(samples: np.ndarray, period_hint: float) -> dict | None:
    """Distances in ms of the pulse from straight grids, over the window and over 16-bar spans."""
    times, env = envelope(np.ascontiguousarray(samples, dtype=np.float32))
    period = refine_period(times, env, period_hint)
    rows = local_offsets(times, env, period)
    if len(rows) < 6:
        return None
    centres, offsets, clarity = rows.T
    residual = np.abs(_line_residuals(centres, offsets, clarity))
    order = np.argsort(residual)
    cumulative = np.cumsum(clarity[order])
    median = float(residual[order][np.searchsorted(cumulative, 0.5 * cumulative[-1])])
    clear = clarity >= np.median(clarity)
    spans = []
    for centre in centres:
        inside = np.abs(centres - centre) <= SPAN_BEATS * period / 2
        if inside.sum() >= 8:
            spans.append(float(np.abs(_line_residuals(centres[inside], offsets[inside], clarity[inside])).max()))
    return {
        'window_median_ms': median * 1000,
        'window_max_ms': float(residual[clear].max()) * 1000,
        'span64_max_ms': statistics.median(spans) * 1000 if spans else None,
        'clarity': float(np.median(clarity)),
    }


# --- synthetic signals with known beat times -------------------------------

def drums(beats: np.ndarray, jitter_ms: float, seconds: float, seed: int = 0) -> np.ndarray:
    """Kick/snare on the beats, hats on eighths, each hit displaced by N(0, jitter); a held chord."""
    rng = np.random.default_rng(seed)
    out = np.zeros(int(seconds * SR) + SR, np.float32)
    t = np.arange(int(0.15 * SR)) / SR
    kick = (np.sin(2 * np.pi * (50 + 80 * np.exp(-t * 40)) * t) * np.exp(-t * 25)).astype(np.float32)
    n = int(0.1 * SR)
    snare = (rng.standard_normal(n) * np.exp(-np.arange(n) / SR * 30) * 0.5).astype(np.float32)
    n = int(0.03 * SR)
    hat = (np.diff(rng.standard_normal(n + 1)) * np.exp(-np.arange(n) / SR * 120) * 0.15).astype(np.float32)

    def add(at, sound):
        i = int(round((at + rng.normal(0, jitter_ms / 1000)) * SR))
        if 0 <= i < out.size - sound.size:
            out[i:i + sound.size] += sound

    for k, beat in enumerate(beats):
        following = beats[k + 1] if k + 1 < len(beats) else beat + (beat - beats[k - 1])
        add(beat, kick if k % 2 == 0 else snare)
        add(beat, hat)
        add((beat + following) / 2, hat)
    clock = np.arange(out.size) / SR
    chord = 0.05 * sum(np.sin(2 * np.pi * f * clock) for f in (220.0, 277.2, 329.6))
    return (out + chord.astype(np.float32))[:int(seconds * SR)]


def drifting_beats(bpm: float, seconds: float, depth: float, cycle: float) -> np.ndarray:
    """Beat times of a tempo that swings ±depth sinusoidally every `cycle` seconds."""
    t = np.arange(0, seconds, 0.001)
    phase = np.cumsum(bpm / 60 * (1 + depth * np.sin(2 * np.pi * t / cycle))) * 0.001
    return np.interp(np.arange(1, phase[-1]), phase, t)


def truth_ms(beats: np.ndarray) -> tuple[float, float]:
    """Median and largest distance of the true beats from their best straight line."""
    n = np.arange(len(beats))
    residual = np.abs(beats - np.polyval(np.polyfit(n, beats, 1), n))
    return float(np.median(residual)) * 1000, float(residual.max()) * 1000


def synthetic(analyser: bool) -> list[dict]:
    seconds = 180.0
    cases = [(f'constant 120 BPM, jitter {j} ms', np.arange(0.5, seconds, 0.5), j) for j in (0, 5, 10, 15, 20)]
    cases += [(f'tempo ±{d * 100:.1f} % every {c:.0f} s, jitter 10 ms', drifting_beats(120, seconds, d, c), 10)
              for d, c in ((0.002, 60), (0.005, 60), (0.01, 60), (0.01, 20), (0.02, 60))]
    results = []
    for name, beats, jitter in cases:
        signal = drums(beats, jitter, seconds)
        measured = straightness(signal, 0.5)
        true_median, true_max = truth_ms(beats)
        row = {'case': name, 'true_median_ms': round(true_median, 1), 'true_max_ms': round(true_max, 1),
               'measured_median_ms': round(measured['window_median_ms'], 1),
               'measured_max_ms': round(measured['window_max_ms'], 1)}
        if analyser:
            row['analyser_tempo_confidence'] = _analyser_confidence(signal, seconds)
        results.append(row)
    return results


def _analyser_confidence(signal: np.ndarray, seconds: float) -> float | None:
    from shared.dj import store

    pcm = (signal / np.abs(signal).max() * 0.8 * 32767).astype('<i2')
    with tempfile.TemporaryDirectory() as folder:
        path = Path(folder) / 'probe.wav'
        with wave.open(str(path), 'wb') as out:
            out.setnchannels(1)
            out.setsampwidth(2)
            out.setframerate(SR)
            out.writeframes(pcm.tobytes())
        analysis = store._analyse_pcm(path, duration_hint=seconds)
    return None if analysis is None else round(float(analysis['tempo_confidence']), 2)


# --- the library -----------------------------------------------------------

def _decode(path: str, start: float = 0.0, length: float = 0.0) -> np.ndarray:
    command = ['ffmpeg', '-nostdin', '-v', 'error']
    if start > 0:
        command += ['-ss', f'{start:.3f}']
    command += ['-i', path]
    if length > 0:
        command += ['-t', f'{length:.3f}']
    command += ['-vn', '-ac', '1', '-ar', str(SR), '-f', 'f32le', 'pipe:1']
    done = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=300, check=False)
    return np.frombuffer(done.stdout, dtype='<f4')


def _measure_song(job) -> dict | None:
    path, analysis = job
    duration = analysis.get('duration') or 0
    windows = [(0.0, 0.0)] if duration <= WINDOWED_ABOVE else [(0.0, HEAD), (max(0.0, duration - TAIL), TAIL)]
    found = []
    for start, length in windows:
        samples = _decode(path, start, length)
        if samples.size < SR * 20:
            return None
        result = straightness(samples, 60 / analysis['bpm'])
        if result is None or result['span64_max_ms'] is None:
            return None
        found.append(result)
    # The analyser keeps the weaker of its two windows; so does this reading.
    return {
        'steady': analysis['tempo_confidence'] > 0.6,
        'window_median_ms': max(r['window_median_ms'] for r in found),
        'span64_max_ms': max(r['span64_max_ms'] for r in found),
        'clarity': min(r['clarity'] for r in found),
    }


def _stamps(music: Path | None, previews: Path | None) -> dict[str, str]:
    """source_stamp → file, as shared/dj/store.py writes it (size:mtime_ns, or size:revision for previews)."""
    stamps = {}
    if music:
        for folder, _, names in os.walk(music):
            for name in names:
                path = Path(folder) / name
                try:
                    stat = path.stat()
                except OSError:
                    continue
                stamps[f'{stat.st_size}:{stat.st_mtime_ns}'] = str(path)
    if previews and previews.exists():
        for path in previews.glob('*.audio'):
            stat = path.stat()
            stamps[f'{stat.st_size}:{stat.st_mtime_ns}'] = str(path)
            try:
                revision = json.loads(path.with_suffix('.meta.json').read_text()).get('revision')
            except (OSError, ValueError, AttributeError):
                revision = None
            if revision:
                stamps[f'{stat.st_size}:{revision}'] = str(path)
    return stamps


def _quantiles(values: list[float]) -> dict:
    values = sorted(values)
    if not values:
        return {'count': 0}
    pick = lambda q: round(values[int(q * (len(values) - 1))], 1)  # noqa: E731
    return {'count': len(values), 'p10': pick(0.1), 'p25': pick(0.25), 'median': pick(0.5),
            'p75': pick(0.75), 'p90': pick(0.9)}


def library(analysis_db: Path, music: Path | None, previews: Path | None, workers: int) -> dict:
    from shared.dj.contracts import ANALYSER_VERSION

    stamps = _stamps(music, previews)
    uri = analysis_db.expanduser().resolve().as_uri() + '?mode=ro'
    with sqlite3.connect(uri, uri=True) as db:
        rows = db.execute('SELECT source_stamp, payload FROM audio_analysis WHERE analyser_version = ?',
                          (ANALYSER_VERSION,)).fetchall()
    analysed = [(stamp, json.loads(payload)) for stamp, payload in rows]
    analysed = [(stamp, a) for stamp, a in analysed if a.get('analysed') and (a.get('bpm') or 0) > 0]
    jobs = [(stamps[stamp], a) for stamp, a in analysed if stamp in stamps]
    with ProcessPoolExecutor(max_workers=workers) as pool:
        measured = [m for m in pool.map(_measure_song, jobs, chunksize=4) if m is not None]
    report = {'analysed_with_pulse': len(analysed), 'file_found': len(jobs), 'measured': len(measured)}
    for label, group in (('steady', True), ('not_steady', False)):
        members = [m for m in measured if m['steady'] is group]
        report[label] = {
            'window_median_ms': _quantiles([m['window_median_ms'] for m in members]),
            'span64_max_ms': _quantiles([m['span64_max_ms'] for m in members]),
            'clarity': _quantiles([m['clarity'] * 100 for m in members]),
        }
        for limit in (5, 10, 12, 20):
            report[label][f'window_median_within_{limit}_ms'] = sum(m['window_median_ms'] <= limit for m in members)
            report[label][f'span64_max_within_{limit}_ms'] = sum(m['span64_max_ms'] <= limit for m in members)
        report[label]['by_clarity'] = {}
        for low, high in ((0.9, 1.01), (0.8, 0.9), (0.6, 0.8), (0.0, 0.6)):
            band = [m for m in members if low <= m['clarity'] < high]
            report[label]['by_clarity'][f'{low:.1f}-{min(high, 1.0):.1f}'] = {
                'songs': len(band),
                'window_median_ms': _quantiles([m['window_median_ms'] for m in band]).get('median'),
                'window_median_within_12_ms': sum(m['window_median_ms'] <= 12 for m in band),
            }
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='mode', required=True)
    synth = sub.add_parser('synthetic')
    synth.add_argument('--analyser', action='store_true', help='also run shared.dj.store on each signal')
    lib = sub.add_parser('library')
    lib.add_argument('--analysis', type=Path, required=True)
    lib.add_argument('--music', type=Path)
    lib.add_argument('--previews', type=Path)
    lib.add_argument('--workers', type=int, default=max(1, (os.cpu_count() or 2) // 2))
    args = parser.parse_args()
    if args.mode == 'synthetic':
        print(json.dumps(synthetic(args.analyser), indent=2))
    else:
        print(json.dumps(library(args.analysis, args.music, args.previews, args.workers), indent=2))


if __name__ == '__main__':
    main()
