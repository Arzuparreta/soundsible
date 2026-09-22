"""Compare the legacy JSON roundtrip with direct public library snapshots.

Synthetic conversion only: excludes SQL, annotations, HTTP and compression.
Run: venv/bin/python scripts/benchmark_library_payload.py
"""
from dataclasses import asdict
import argparse
import gc
import json
from pathlib import Path
import statistics
import sys
import time
import tracemalloc

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from shared.models import LibraryMetadata, Track


def legacy_payload(metadata):
    return json.loads(json.dumps({
        "version": metadata.version,
        "tracks": [
            {key: value for key, value in asdict(track).items()
             if key not in {"local_path", "local_mtime_ns"}}
            for track in metadata.tracks
        ],
        "playlists": metadata.playlists,
        "settings": metadata.settings,
        "last_updated": metadata.last_updated,
        "podcast_subscriptions": list(metadata.podcast_subscriptions),
        "podcast_episode_cache": dict(metadata.podcast_episode_cache),
    }, indent=2))


def wire(payload):
    return json.dumps(payload, separators=(",", ":")).encode()


def measure(build, repeats):
    samples = []
    for _ in range(repeats):
        gc.collect()
        start = time.perf_counter()
        result = wire(build())
        samples.append((time.perf_counter() - start) * 1000)
        del result
    # Separate run: tracemalloc materially changes timing.
    gc.collect()
    tracemalloc.start()
    result = wire(build())
    _, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    return {
        "median_ms": round(statistics.median(samples), 2),
        "peak_python_bytes": peak,
        "wire_bytes": len(result),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sizes", type=int, nargs="+", default=[1000, 10000, 50000])
    parser.add_argument("--repeats", type=int, default=3)
    args = parser.parse_args()
    if args.repeats < 1 or any(size < 0 for size in args.sizes):
        parser.error("repeats must be positive and sizes nonnegative")
    for count in args.sizes:
        metadata = LibraryMetadata(1, [
            Track(
                id=str(i), title="Title", artist="Artist", album="Album", duration=240,
                file_hash=str(i), original_filename=f"{i}.mp3", compressed=False,
                file_size=1000000, bitrate=320, format="mp3",
            ) for i in range(count)
        ], {}, {}, last_updated="2026-01-01T00:00:00")
        def before():
            return legacy_payload(metadata)

        after = metadata.to_public_dict
        assert wire(before()) == wire(after()), "public payload changed"
        print(json.dumps({
            "tracks": count,
            "legacy": measure(before, args.repeats),
            "direct": measure(after, args.repeats),
        }), flush=True)


if __name__ == "__main__":
    main()
