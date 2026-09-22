"""Synthetic local selection cost, excluding providers, HTTP and playback.

Compare the frozen pre-optimization selector with current code, asserting full
payload equivalence. No persistent cache: each repetition is a fresh request.
Run: venv/bin/python scripts/benchmark_local_catalog.py --repeats 3
"""
import argparse
import gc
import importlib.util
import json
from pathlib import Path
import runpy
import statistics
import sys
import time
import tracemalloc
from types import FunctionType

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from shared.models import Track


def measure(function, query, repeats):
    samples = []
    for _ in range(repeats):
        gc.collect()
        start = time.perf_counter()
        result = function(query, 30)
        samples.append((time.perf_counter() - start) * 1000)
    gc.collect()
    tracemalloc.start()
    function(query, 30)
    _, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    return result, {"median_ms": round(statistics.median(samples), 2), "peak_mib": round(peak / 2**20, 2)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sizes", nargs="+", type=int, default=[1000, 10000, 50000])
    parser.add_argument("--repeats", type=int, default=3)
    args = parser.parse_args()
    spec = importlib.util.spec_from_file_location("benchmark_catalog", ROOT / "shared/api/routes/catalog.py")
    catalog = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(catalog)
    frozen = runpy.run_path(str(ROOT / "tests/fixtures/local_catalog_reference.py"))["_local_catalog"]
    reference = FunctionType(frozen.__code__, vars(catalog))
    for size in args.sizes:
        tracks = [Track(
            id=f"t{i:06}", title=f"Song {i}", artist=f"Artist {i // 100}", album=f"Album {i // 10}",
            duration=180, file_hash=f"hash{i}", original_filename=f"{i}.mp3",
            compressed=False, file_size=1000, bitrate=320, format="mp3",
        ) for i in range(size)]
        catalog._library_tracks = lambda: tracks
        for query in ("artist", "song", "album 17", "absent"):
            before, old = measure(reference, query, args.repeats)
            after, new = measure(catalog._local_catalog, query, args.repeats)
            assert before == after, (size, query)
            print(json.dumps({"tracks": size, "query": query, "before": old, "after": new}), flush=True)


if __name__ == "__main__":
    main()
