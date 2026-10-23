"""Measure a deterministic cohort of existing previews without station writes.

python -I docs/dj/pool_probe.py --previews ~/.cache/soundsible/previews
Audio is read in place; SQLite/features go to a disposable runtime. Reports
actual encoded size and decode+analysis CPU/wall cost. It does not estimate CDN
latency from disk reads. --download measures real acquisition with the normal
resolver and single upstream lane, also inside that disposable runtime.
"""
from __future__ import annotations

import argparse
from dataclasses import replace
import json
from pathlib import Path
import random
import statistics
import sys
import tempfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from shared.dj_engine import analyse_audio, analysis_identity
from shared.runtime import RuntimeConfig, configure_runtime


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--previews', required=True, type=Path)
    parser.add_argument('--count', type=int, default=16)
    parser.add_argument('--seed', type=int, default=0)
    parser.add_argument('--download', action='store_true')
    args = parser.parse_args()
    if not 1 <= args.count <= 46:
        parser.error('count must be between 1 and 46')
    paths = sorted(args.previews.glob('*.audio'))
    random.Random(args.seed).shuffle(paths)
    paths = paths[:args.count]
    if not paths:
        parser.error('no previews found')
    results = []
    with tempfile.TemporaryDirectory(prefix='soundsible-dj-pool-') as directory:
        root = Path(directory)
        runtime = replace(RuntimeConfig.default(), **{name: root / name for name in
            ('config_dir', 'data_dir', 'cache_dir', 'log_dir', 'music_dir')})
        configure_runtime(runtime)
        for name in ('config_dir', 'data_dir', 'cache_dir', 'log_dir', 'music_dir'):
            getattr(runtime, name).mkdir()
        for path in paths:
            download_seconds = None
            if args.download:
                from shared import preview_cache
                from shared.downloader.youtube import streams
                from shared.downloader.youtube.ytdlp import Cookies
                started = time.perf_counter()
                def resolve(video_id):
                    return streams.get_resolved_stream(video_id, Cookies())
                def refresh(video_id):
                    return streams.get_resolved_stream(video_id, Cookies(), skip_fast_path=True)
                try:
                    from unittest.mock import patch
                    # Time the synchronous analysis below, without the normal
                    # commit hook racing that same measurement in a worker.
                    with patch('shared.dj_engine.request_analysis'):
                        cached, _ = preview_cache.acquire_cached(path.stem, resolve, refresh_resolver=refresh)
                except Exception as exc:
                    results.append({'acquisition_error': type(exc).__name__, 'wall_s': time.perf_counter() - started})
                    continue
                download_seconds = time.perf_counter() - started
                if not cached:
                    results.append({'acquisition_error': 'unavailable', 'wall_s': download_seconds})
                    continue
                path = cached[0]
            started, cpu = time.perf_counter(), time.process_time()
            # Direct call is synchronous; no duplicate background job in probe.
            analysis = analyse_audio(path, analysis_identity({'youtube_id': path.stem}))
            results.append({'bytes': path.stat().st_size, 'duration_s': analysis['duration'],
                            'analysed': analysis['analysed'], 'cpu_s': time.process_time() - cpu,
                            'wall_s': time.perf_counter() - started, 'acquisition_s': download_seconds})
    good = [row for row in results if row.get('analysed')]
    print(json.dumps({'count': len(paths), 'measured': len(good), 'download': args.download,
                      'bytes_total': sum(row['bytes'] for row in good),
                      'cpu_s_total': sum(row['cpu_s'] for row in good),
                      'wall_s_total': sum(row['wall_s'] for row in results),
                      'median_bytes': statistics.median(row['bytes'] for row in good) if good else None,
                      'median_cpu_s': statistics.median(row['cpu_s'] for row in good) if good else None,
                      'results': results}, indent=2))


if __name__ == '__main__':
    main()
