"""Compare complete durable three-copy exports on the selected interpreter.

Only standard-library/application model/file modules are needed. Both paths
must publish exactly to_json()'s bytes; SQLite and provider objects are excluded.
"""
import argparse
import gc
import inspect
from hashlib import sha256
import json
from pathlib import Path
import statistics
import sys
import tempfile
import textwrap
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from shared import models
from shared.atomic_file import publish, text_pieces, copy_of, replace_contents
from shared.models import LibraryMetadata, Track
from shared.library_json import encode_track_block


def functions():
    previous = LibraryMetadata.iter_json
    source = textwrap.dedent(inspect.getsource(previous))
    expression = 'json.dumps(block, indent=2)[1:-2].replace("\\n", "\\n  ")'
    if expression not in source:
        expression = 'encode_track_block(block)'
    assert expression in source
    encoders = {}
    for name, flat in [('standard', False), ('flat', True)]:
        scope = dict(vars(models), encode_track_block=encode_track_block)
        exec(compile(source.replace(expression, f'encode_track_block(block, flat={flat})'),
                     '<track encoder>', 'exec'), scope)
        encoders[name] = scope['iter_json']
    return encoders


def run(count, repeats):
    metadata = LibraryMetadata(1, [Track(
        id=f'{i:032x}', title=f'Song {i}', artist=f'Artist {i // 100}', album=f'Álbum {i // 10}',
        duration=180, file_hash=f'{i:064x}', original_filename=f'{i}.flac', file_size=30000000,
        bitrate=1411, format='flac', artists=['Artist'], added_at='2026-01-01T00:00:00') for i in range(count)], {}, {})
    expected = metadata.to_json().encode()
    encoders = functions()
    samples, cpus = {key: [] for key in encoders}, {key: [] for key in encoders}
    with tempfile.TemporaryDirectory(prefix='soundsible-encoder-', dir=ROOT.parent) as directory:
        paths = [Path(directory) / name for name in ('user.json', 'music.json', 'provider.json')]
        for repeat in range(repeats):
            for name in (list(encoders) if repeat % 2 == 0 else list(encoders)[::-1]):
                gc.collect()
                cpu, start = time.process_time(), time.perf_counter()
                publish(paths[0], text_pieces(encoders[name](metadata)))
                publish(paths[1], copy_of(paths[0]))
                replace_contents(paths[2], copy_of(paths[0]))
                samples[name].append((time.perf_counter() - start) * 1000)
                cpus[name].append((time.process_time() - cpu) * 1000)
                assert all(path.read_bytes() == expected for path in paths)
    return {'tracks': count, **{name: {'median_ms': statistics.median(samples[name]), 'samples_ms': samples[name],
                                      'cpu_median_ms': statistics.median(cpus[name])} for name in encoders}}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sizes', type=int, nargs='+', default=[200, 10000, 50000])
    parser.add_argument('--repeats', type=int, default=7)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    with args.output.open('w') as output:
        output.write(json.dumps({'python': sys.version, 'scope': __doc__,
                                 'source_sha256': {name: sha256((ROOT / name).read_bytes()).hexdigest() for name in
                                                   ['shared/models.py', 'shared/library_json.py', 'scripts/benchmark_portable_encoder.py']}}) + '\n')
        for size in args.sizes:
            row = run(size, args.repeats)
            output.write(json.dumps(row) + '\n')
            output.flush()
            print(json.dumps(row), flush=True)
