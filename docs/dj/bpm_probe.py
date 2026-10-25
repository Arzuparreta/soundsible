"""Measure how precisely the DJ analyser reads tempo and places beats.

Run from the repository root:

    python -I docs/dj/bpm_probe.py

It writes click tracks at known tempos to a temporary directory, runs them
through `shared.dj_engine.analyse_audio` with a throwaway cache, and prints the
tempo the analyser reports next to the real one, the period it would use to
stretch a mix, and how far the grid sits from the clicks. Needs NumPy and
FFmpeg. `tests/test_dj_beat_grid.py` holds the same measurements as asserts.
"""

import os
import sys
import tempfile
import wave
from pathlib import Path

import numpy as np

sys.path.insert(0, os.getcwd())
from shared import dj_engine  # noqa: E402
from shared.dj import store as dj_store, timing as dj_timing

SAMPLE_RATE = 44100
DURATION = 60.0
TEMPOS = (118, 120, 122, 124, 126, 128, 130, 140, 174)


def click_track(bpm: float) -> tuple[np.ndarray, np.ndarray]:
    """A kick on every odd beat, a hat on every even one, accented downbeats."""
    samples = np.zeros(int(SAMPLE_RATE * DURATION), dtype=np.float32)
    length = int(0.03 * SAMPLE_RATE)
    envelope = np.exp(-np.arange(length) / (0.006 * SAMPLE_RATE))
    onsets = []
    position = 0.5
    beat = 0
    while position < DURATION - 0.1:
        start = int(position * SAMPLE_RATE)
        pitch = 80 if beat % 2 == 0 else 2000
        amplitude = 1.0 if beat % 4 == 0 else 0.6
        tone = np.sin(2 * np.pi * pitch * np.arange(length) / SAMPLE_RATE)
        samples[start:start + length] += amplitude * envelope * tone
        onsets.append(start / SAMPLE_RATE)
        position += 60.0 / bpm
        beat += 1
    return samples, np.array(onsets)


def main() -> None:
    workdir = Path(tempfile.mkdtemp(prefix="dj-bpm-probe-"))
    dj_store._cache_path = lambda: workdir / "analysis.sqlite3"
    print(f"{'real':>6}  {'bpm':>9}  {'stretch period':>14}  grid − click (ms): median, worst")
    for bpm in TEMPOS:
        path = workdir / f"click-{bpm}.wav"
        samples, onsets = click_track(bpm)
        with wave.open(str(path), "wb") as out:
            out.setnchannels(1)
            out.setsampwidth(2)
            out.setframerate(SAMPLE_RATE)
            out.writeframes((np.clip(samples, -1, 1) * 30000).astype("<i2").tobytes())
        analysis = dj_engine.analyse_audio(path, f"probe-{bpm}", duration_hint=DURATION)
        grid = np.array(analysis["beat_grid"])
        period = dj_timing.local_period(analysis, float(grid[len(grid) // 2]), 30.0)
        index = np.clip(np.searchsorted(grid, onsets), 1, grid.size - 1)
        nearest = np.where(np.abs(onsets - grid[index - 1]) < np.abs(onsets - grid[index]), grid[index - 1], grid[index])
        error = (nearest - onsets) * 1000
        print(f"{bpm:>6}  {analysis['bpm']:>9.3f}  {60 / period:>11.3f} BPM  {np.median(error):+.2f}, {np.max(np.abs(error)):.2f}")


if __name__ == "__main__":
    main()
