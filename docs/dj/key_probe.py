"""Measure key detection on known cadences, without touching the station cache.

Run from the repository root: python -I docs/dj/key_probe.py --reference origin/main
Optional: --audio /path/to/song.flac (repeatable) compares complete audio analyses.
The reference must be trusted: its Python implementation is executed.
"""
from __future__ import annotations

import argparse
import json
import sys
import types
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from shared.dj import features, store
from docs.dj.reference import load_reference

dj_engine = types.SimpleNamespace(_KEY_NAMES=features._KEY_NAMES,
                                  _window_features=features._window_features,
                                  _analyse_pcm=store._analyse_pcm)


def cadence(tonic: int, mode: str, *, octave: int = 3, harmonics: int = 1, cents: float = 0.0):
    """I–IV–ii–V–I / i–iv–ii°–V–i, two seconds per chord, A4=440 Hz.

    Equal-amplitude chord tones, partials 1/h, 20 ms attack and 100 ms release.
    These describe the signal, not a desired key-profile distribution.
    """
    rate = 11025
    chords = (
        [(0, 4, 7), (5, 9, 12), (2, 5, 9), (7, 11, 14), (0, 4, 7)]
        if mode == "major" else
        [(0, 3, 7), (5, 8, 12), (2, 5, 8), (7, 11, 14), (0, 3, 7)]
    )
    t = np.arange(rate * 2) / rate
    envelope = np.minimum(t / .02, 1) * np.minimum((2 - t) / .1, 1)
    rows = []
    for chord in chords:
        samples = np.zeros_like(t)
        for note in chord:
            frequency = 440 * 2 ** ((12 * (octave + 1) + tonic + note - 69 + cents / 100) / 12)
            for harmonic in range(1, harmonics + 1):
                samples += np.sin(2 * np.pi * frequency * harmonic * t) / harmonic
        rows.append(samples * envelope / 20)
    return np.concatenate(rows).astype(np.float32)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reference")
    parser.add_argument("--audio", action="append", type=Path)
    args = parser.parse_args()
    engines = [("current", dj_engine)]
    if args.reference:
        engines.insert(0, (args.reference, load_reference(args.reference)))
    if args.audio:
        for path in args.audio:
            row = {"audio": path.name}
            for label, engine in engines:
                features = engine._analyse_pcm(path, duration_hint=0.0)
                row[label] = {key: features[key] for key in ("key", "mode", "duration")}
            print(json.dumps(row), flush=True)
        return
    for octave, harmonics in ((3, 1), (1, 1), (3, 6), (1, 6)):
        counts = {label: 0 for label, _ in engines}
        failures = {label: [] for label, _ in engines}
        for mode in ("major", "minor"):
            for tonic, key in enumerate(dj_engine._KEY_NAMES):
                samples = cadence(tonic, mode, octave=octave, harmonics=harmonics)
                for label, engine in engines:
                    features = engine._window_features(samples, 11025)
                    found = (features["key"], features["mode"])
                    counts[label] += found == (key, mode)
                    if found != (key, mode):
                        failures[label].append({"expected": [key, mode], "found": found})
        print(json.dumps({"octave": octave, "harmonics": harmonics, "of": 24,
                          "correct": counts, "failures": failures}), flush=True)


if __name__ == "__main__":
    main()
