"""Portable library.json export: previous exporter versus the streamed one.

Both write the same three copies a default single-user install writes: the
per-user manifest, `<music>/library.json` and the local storage provider's
mirror. Every copy must equal `to_json()` byte for byte. Measured per export:
wall time (median), Python allocation peak (tracemalloc; excludes the loaded
library), bytes passed to write() (`wchar`) and sent to storage (`write_bytes`)
from /proc/self/io, and how many whole-library serializations ran. The SQLite
save that precedes an export in the application is not included.

Temporary files live on the repository storage volume.
Run: venv/bin/python scripts/benchmark_library_export.py --repeats 5
     venv/bin/python scripts/benchmark_library_export.py --library PATH/library.json
"""
import argparse
import ast
import gc
import json
from pathlib import Path
import random
import statistics
import subprocess
import sys
import tempfile
import threading
import time
import tracemalloc

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import player.library as player_library
from setup_tool.local_provider import LocalStorageProvider
from shared.models import LibraryMetadata, Track


def previous_exporter(revision):
    """`_atomic_write` and `_export_metadata` as they were at `revision`."""
    source = subprocess.check_output(["git", "show", f"{revision}:player/library.py"], cwd=ROOT, text=True)
    cls = next(node for node in ast.parse(source).body if isinstance(node, ast.ClassDef) and node.name == "LibraryManager")
    methods = [node for node in cls.body if isinstance(node, ast.FunctionDef) and node.name in {"_atomic_write", "_export_metadata"}]
    scope = dict(vars(player_library))
    exec(compile(ast.Module(body=methods, type_ignores=[]), "<previous exporter>", "exec"), scope)
    return scope


def library(count):
    rng = random.Random(count)
    return LibraryMetadata(1, [Track(
        id=f"{rng.getrandbits(128):032x}", title=f"Song {i}" + (" (Live)" if i % 7 == 0 else ""),
        artist=f"Artist {i // 100}", album=f"Álbum {i // 10}", duration=180 + i % 60,
        file_hash=f"{rng.getrandbits(256):064x}", original_filename=f"{i}.flac", compressed=False,
        file_size=30_000_000 + i, bitrate=1411, format="flac", year=1990 + i % 30, genre="Rock",
        track_number=i % 12 + 1, artists=[f"Artist {i // 100}"], youtube_id=f"{i:011d}",
        added_at="2026-01-01T00:00:00",
    ) for i in range(count)], {"Mix": [f"{i}" for i in range(50)]}, {"theme": "dark"})


def io_counters():
    with open("/proc/self/io") as handle:
        values = dict(line.split(": ") for line in handle.read().splitlines())
    return int(values["wchar"]), int(values["write_bytes"])


def exporter(directory, previous, metadata):
    """An object carrying just what `_export_metadata` reads, writing under `directory`."""
    provider = LocalStorageProvider()
    provider.authenticate({"base_path": str(directory / "provider")})
    provider.bucket_name = "bucket"
    scope = previous or vars(player_library)
    namespace = {"_atomic_write": scope["_atomic_write"] if previous else player_library.LibraryManager.__dict__["_atomic_write"],
                 "_export_metadata": scope["_export_metadata"] if previous else player_library.LibraryManager._export_metadata}
    target = type("Exporter", (), namespace)()
    target.manifest_path = directory / "config" / "library.json"
    target.provider, target.metadata = provider, metadata
    target._unwritable_paths, target._log, target._export_lock = set(), print, threading.Lock()
    copies = [target.manifest_path, directory / "music" / "library.json", directory / "provider" / "bucket" / "library.json"]
    return target, copies


def measure(name, metadata, previous, repeats, root):
    expected = metadata.to_json().encode("utf-8")
    row = {"library": name, "tracks": len(metadata.tracks), "bytes": len(expected)}
    for label, scope in (("previous", previous), ("current", None)):
        with tempfile.TemporaryDirectory(prefix="soundsible-export-", dir=root) as directory:
            directory = Path(directory)
            for module in filter(None, (scope, vars(player_library))):
                module["_output_dir_for_library"] = lambda: directory / "music"
                module["_music_dir_manifest_is_shared"] = lambda: False
            target, copies = exporter(directory, scope, metadata)
            serializations = []
            original_to_json, original_iter = LibraryMetadata.to_json, LibraryMetadata.iter_json
            LibraryMetadata.to_json = lambda self, *a, **k: serializations.append("to_json") or original_to_json(self, *a, **k)
            LibraryMetadata.iter_json = lambda self, *a, **k: serializations.append("iter_json") or original_iter(self, *a, **k)
            try:
                # The previous caller serialized before the call; include it.
                run = (lambda: target._export_metadata(metadata.to_json())) if scope else (lambda: target._export_metadata(metadata))
                samples, written = [], []
                for _ in range(repeats):
                    gc.collect()
                    before = io_counters()
                    start = time.perf_counter()
                    run()
                    samples.append((time.perf_counter() - start) * 1000)
                    after = io_counters()
                    written.append((after[0] - before[0], after[1] - before[1]))
                per_export = len(serializations) // repeats
                gc.collect()
                tracemalloc.start()
                run()
                _, peak = tracemalloc.get_traced_memory()
                tracemalloc.stop()
            finally:
                LibraryMetadata.to_json, LibraryMetadata.iter_json = original_to_json, original_iter
            assert all(path.read_bytes() == expected for path in copies), (name, label)
            row[label] = {
                "median_ms": round(statistics.median(samples), 2),
                "peak_mib": round(peak / 2**20, 3),
                "wchar_bytes": int(statistics.median(w[0] for w in written)),
                "storage_write_bytes": int(statistics.median(w[1] for w in written)),
                "serializations": per_export,
            }
    print(json.dumps(row), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reference", default="89493bc")
    parser.add_argument("--sizes", type=int, nargs="*", default=[200, 1000, 10000, 50000])
    parser.add_argument("--library", type=Path, help="measure an existing library.json (read only)")
    parser.add_argument("--repeats", type=int, default=5)
    args = parser.parse_args()
    if args.repeats < 1:
        parser.error("positive repeats required")
    previous = previous_exporter(args.reference)
    if args.library:
        measure("given", LibraryMetadata.from_json(args.library.read_text(encoding="utf-8")), previous, args.repeats, ROOT.parent)
    for size in args.sizes:
        measure(f"synthetic-{size}", library(size), previous, args.repeats, ROOT.parent)


if __name__ == "__main__":
    main()
