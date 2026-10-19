"""Measure how precisely the DJ analyser reads tempo.

Run from the repository root:

    python -I docs/dj/bpm_probe.py

It writes click tracks at known tempos to a temporary directory, runs them
through `shared.dj_engine.analyse_audio` with a throwaway cache, and prints the
tempo the analyser reports next to the real one. Needs NumPy and FFmpeg.
"""

import os
import sys
import tempfile
import wave
from pathlib import Path

import numpy as np

sys.path.insert(0, os.getcwd())
from shared import dj_engine  # noqa: E402

SAMPLE_RATE = 44100
DURATION = 60.0
TEMPOS = (118, 120, 122, 124, 126, 128, 130, 140, 174)


def click_track(bpm: float) -> np.ndarray:
    """A kick on every odd beat, a hat on every even one, accented downbeats."""
    samples = np.zeros(int(SAMPLE_RATE * DURATION), dtype=np.float32)
    length = int(0.03 * SAMPLE_RATE)
    envelope = np.exp(-np.arange(length) / (0.006 * SAMPLE_RATE))
    position = 0.5
    beat = 0
    while position < DURATION - 0.1:
        start = int(position * SAMPLE_RATE)
        pitch = 80 if beat % 2 == 0 else 2000
        amplitude = 1.0 if beat % 4 == 0 else 0.6
        tone = np.sin(2 * np.pi * pitch * np.arange(length) / SAMPLE_RATE)
        samples[start:start + length] += amplitude * envelope * tone
        position += 60.0 / bpm
        beat += 1
    return samples


def main() -> None:
    workdir = Path(tempfile.mkdtemp(prefix="dj-bpm-probe-"))
    dj_engine._cache_path = lambda: workdir / "analysis.sqlite3"
    print(f"{'real':>6}  {'bpm':>8}  {'local':>8}  beat intervals (s)")
    for bpm in TEMPOS:
        path = workdir / f"click-{bpm}.wav"
        with wave.open(str(path), "wb") as out:
            out.setnchannels(1)
            out.setsampwidth(2)
            out.setframerate(SAMPLE_RATE)
            pcm = (np.clip(click_track(bpm), -1, 1) * 30000).astype("<i2")
            out.writeframes(pcm.tobytes())
        analysis = dj_engine.analyse_audio(path, f"probe-{bpm}", duration_hint=DURATION)
        grid = analysis["beat_grid"]
        local = dj_engine._local_period(analysis, grid[len(grid) // 2])
        intervals = sorted({round(float(value), 3) for value in np.diff(grid)})
        print(f"{bpm:>6}  {analysis['bpm']:>8.2f}  {60 / local:>8.2f}  {intervals[:4]}")


if __name__ == "__main__":
    main()
