"""Disk quota/latency/extra Python allocation, not playback or total RSS.

Uses storage beside the repository, never /tmp. Legacy fixtures are JPEG copies
with valid variant names; only the requested cold variant runs the real encoder.
"""
import argparse
import io
import json
from pathlib import Path
import statistics
import sys
import tempfile
import time
import tracemalloc

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from PIL import Image
from shared.artwork import ArtworkStore


def timed(call, memory=False):
    if memory: tracemalloc.start()
    start = time.perf_counter()
    value = call()
    ms = (time.perf_counter() - start) * 1000
    peak = tracemalloc.get_traced_memory()[1] if memory else None
    if memory: tracemalloc.stop()
    return value, ms, peak


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--counts', type=int, nargs='+', default=[1000, 10000])
    args = parser.parse_args()
    if any(count < 1 for count in args.counts): parser.error('positive counts required')
    for count in args.counts:
        with tempfile.TemporaryDirectory(prefix='soundsible-artwork-bench-', dir=ROOT.parent) as directory:
            root = Path(directory)
            store = ArtworkStore(root / 'data', root / 'cache')
            raw = io.BytesIO()
            Image.effect_noise((640, 640), 50).convert('RGB').save(raw, 'PNG')
            digest = store.put(raw.getvalue())
            initial = store.open_variant(digest, 320)
            jpeg = initial.file.read()
            initial.file.close()
            for i in range(count):
                (store.cache / f'{i:064x}-160-original-jpeg90-v1.jpg').write_bytes(jpeg)
            store = ArtworkStore(store.root, store.cache)
            # Leave room for about half the legacy fixtures, forcing adoption
            # and eviction. This is intentionally a smaller-than-default quota.
            store._variants.limit = max(len(jpeg) * (count // 2 + 1), len(jpeg) * 2)
            item, reconcile_ms, reconcile_peak = timed(lambda: store.open_variant(digest, 320), True)
            item.file.close()
            warm = []
            for _ in range(30):
                item, ms, _ = timed(lambda: store.open_variant(digest, 320))
                item.file.close()
                warm.append(ms)
            item, _, warm_peak = timed(lambda: store.open_variant(digest, 320), True)
            item.file.close()
            item, cold_ms, _ = timed(lambda: store.open_variant(digest, 640))
            item.file.close()
            retained = sum(path.stat().st_size for path in store.cache.glob('*.jpg'))
            assert retained <= store._variants.limit
            print(json.dumps({'fixtures': count, 'limit_bytes': store._variants.limit,
                'retained_jpeg_bytes': retained, 'index_bytes': (store.cache / 'variants.sqlite3').stat().st_size,
                'warm_median_ms': round(statistics.median(warm), 3), 'warm_peak_python_bytes': warm_peak,
                'cold_640_ms': round(cold_ms, 3), 'reconcile_instrumented_ms': round(reconcile_ms, 3),
                'reconcile_peak_python_bytes': reconcile_peak}), flush=True)


if __name__ == '__main__':
    main()
