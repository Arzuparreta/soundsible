"""Compare complete saves and explicit title edits, including portable exports.

Only temporary runtimes are used. This is an edit-cost benchmark, not playback.
"""
import argparse
import json
from pathlib import Path
import statistics
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def run(count, repeats):
    from player.library import LibraryManager
    from scripts.benchmark_library_export import library
    from shared.app_config import set_output_dir
    from shared.runtime import RuntimeConfig, configure_runtime
    from shared.user_context import user_context
    from shared.database import reset_database_managers
    for operation in ('snapshot', 'patch'):
        with tempfile.TemporaryDirectory(prefix='soundsible-edit-', dir=ROOT.parent) as temporary:
            root = Path(temporary)
            env = {f'SOUNDSIBLE_{name.upper()}_DIR': str(root / name) for name in ('config', 'data', 'cache', 'log', 'music')}
            runtime = RuntimeConfig.default(env)
            configure_runtime(runtime)
            set_output_dir(runtime.music_dir)
            with user_context('benchmark'):
                manager = LibraryManager(silent=True)
                manager.metadata = library(count)
                assert manager._save_metadata()
                samples = []
                for index in range(repeats):
                    title = f'Edited {index}'
                    start = time.perf_counter()
                    if operation == 'snapshot':
                        manager.metadata.tracks[0].title = title
                        assert manager._save_metadata()
                    else:
                        assert manager.patch_track_metadata(manager.metadata.tracks[0].id, {'title': title})
                    samples.append((time.perf_counter() - start) * 1000)
                assert manager.db.load_library_metadata().tracks[0].title == title
                print(json.dumps({'tracks': count, 'operation': operation, 'samples_ms': samples,
                                  'median_ms': statistics.median(samples)}), flush=True)
            reset_database_managers()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sizes', nargs='+', type=int, default=[200, 1000, 10000])
    parser.add_argument('--repeats', type=int, default=5)
    args = parser.parse_args()
    if min(args.sizes) < 1 or args.repeats < 1:
        parser.error('sizes and repeats must be positive')
    for size in args.sizes:
        run(size, args.repeats)
