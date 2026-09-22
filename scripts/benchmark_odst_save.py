"""Compare ODST saves with a trusted git baseline in temporary directories.

Existing --library is read-only. Timings exclude tracing; allocation peaks are
separate runs. Phase timing includes read, reconstruction, encoding and writes;
these are application calls, not physical disk latency or durability evidence.
"""
import argparse
import ast
import gc
import hashlib
import platform
import json
from pathlib import Path
import statistics
import subprocess
import sys
import tempfile
import threading
import time
import tracemalloc
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from odst_tool import odst_downloader as module
from shared.models import LibraryMetadata
from scripts.benchmark_library_export import library


def baseline(revision):
    source = subprocess.check_output(['git', 'show', f'{revision}:odst_tool/odst_downloader.py'], text=True, cwd=ROOT)
    cls = next(n for n in ast.parse(source).body if isinstance(n, ast.ClassDef) and n.name == 'ODSTDownloader')
    method = next(n for n in cls.body if isinstance(n, ast.FunctionDef) and n.name == 'save_library')
    scope = dict(vars(module))
    exec(compile(ast.Module(body=[method], type_ignores=[]), '<baseline ODST>', 'exec'), scope)
    return scope


def measure(metadata, reference, repeats, name):
    expected = metadata.to_json()
    samples = {'before': [], 'after': []}
    peaks = {}
    phases = {}
    original_open = open
    original_parse = LibraryMetadata.from_json
    original_json = LibraryMetadata.to_json
    original_iter = LibraryMetadata.iter_json
    original_select = module.read_podcast_fields
    with tempfile.TemporaryDirectory(prefix='odst-save-', dir=ROOT) as directory:
        target = module.ODSTDownloader.__new__(module.ODSTDownloader)
        target.library_path = Path(directory) / 'library.json'
        target.library = metadata
        target._lock = threading.Lock()
        functions = {'before': reference['save_library'], 'after': module.ODSTDownloader.save_library}

        def reset():
            target.library_path.write_text(expected)
            gc.collect()

        def verify():
            assert target.library_path.read_text() == expected

        for repeat in range(repeats):
            for label in (('before', 'after') if repeat % 2 == 0 else ('after', 'before')):
                reset()
                start = time.perf_counter()
                functions[label](target)
                samples[label].append((time.perf_counter() - start) * 1000)
                verify()
        for label, function in functions.items():
            reset()
            tracemalloc.start()
            function(target)
            peaks[label] = tracemalloc.get_traced_memory()[1] / 1024**2
            tracemalloc.stop()
            verify()
            totals = dict.fromkeys(('read_ms', 'parse_ms', 'encode_ms', 'write_ms'), 0.0)

            def timed(key, fn, *args, **kwargs):
                start = time.perf_counter()
                try:
                    return fn(*args, **kwargs)
                finally:
                    totals[key] += (time.perf_counter() - start) * 1000

            class File:
                def __init__(self, *args, **kwargs):
                    self.file = original_open(*args, **kwargs)

                def __enter__(self):
                    return self

                def __exit__(self, *args):
                    return timed('write_ms', self.file.__exit__, *args)

                def read(self, size=-1):
                    return timed('read_ms', self.file.read, size)

                def write(self, value):
                    return timed('write_ms', self.file.write, value)

            def encode(model):
                generator = original_iter(model)
                while True:
                    try:
                        value = timed('encode_ms', next, generator)
                    except StopIteration:
                        return
                    yield value

            def select(source):
                before_read = totals['read_ms']
                try:
                    return timed('parse_ms', original_select, source)
                finally:
                    # The streaming selector reads internally; keep phase
                    # totals exclusive, like the old read-then-parse path.
                    totals['parse_ms'] -= totals['read_ms'] - before_read

            reset()
            reference['open'] = File
            try:
                with (patch.object(module, 'open', File, create=True),
                      patch.object(module, 'read_podcast_fields', side_effect=select),
                      patch.object(LibraryMetadata, 'from_json', side_effect=lambda value: timed('parse_ms', original_parse, value)),
                      patch.object(LibraryMetadata, 'to_json', lambda model: timed('encode_ms', original_json, model)),
                      patch.object(LibraryMetadata, 'iter_json', encode)):
                    function(target)
            finally:
                reference.pop('open', None)
            verify()
            phases[label] = totals
    return {'library': name, 'tracks': len(metadata.tracks), 'json_bytes': len(expected.encode()),
            **{label: {'median_ms': statistics.median(samples[label]), 'samples_ms': samples[label],
                       'peak_mib': peaks[label], 'separate_phase_run': phases[label]} for label in functions}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--reference', default='d06bd64')
    parser.add_argument('--repeats', type=int, default=5)
    parser.add_argument('--sizes', type=int, nargs='+', default=[1000, 10000, 50000])
    parser.add_argument('--library', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.repeats < 1 or any(size < 0 for size in args.sizes):
        parser.error('repeats must be positive and sizes nonnegative')
    reference = baseline(args.reference)
    with args.output.open('w') as out:
        out.write(json.dumps({'baseline': args.reference, 'repeats': args.repeats,
                              'python': sys.version, 'platform': platform.platform(),
                              'candidate_sha256': hashlib.sha256((ROOT / 'odst_tool/odst_downloader.py').read_bytes()).hexdigest(),
                              'podcast_reader_sha256': hashlib.sha256((ROOT / 'odst_tool/library_podcasts.py').read_bytes()).hexdigest(),
                              'scope': 'ODST complete save; temporary copies; Python allocations excluding preloaded model; fsync only where the measured code does it'}) + '\n')
        if args.library:
            row = measure(LibraryMetadata.from_json(args.library.read_text()), reference, args.repeats, 'real-copy')
            out.write(json.dumps(row) + '\n')
            out.flush()
            print(json.dumps(row), flush=True)
        for size in args.sizes:
            row = measure(library(size), reference, args.repeats, f'synthetic-{size}')
            out.write(json.dumps(row) + '\n')
            out.flush()
            print(json.dumps(row), flush=True)


if __name__ == '__main__':
    main()
