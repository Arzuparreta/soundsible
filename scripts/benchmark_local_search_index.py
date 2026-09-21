"""Local search candidates from the SQLite index versus scanning the model.

Three selectors must return equal lists for every query: `previous` is
`_local_catalog` loaded from a git revision, `scan` is the current code over a
plain track list and `indexed` the current code with a proven index. Timings
cover the selector only: no providers, HTTP, JSON or playback. Python peaks use
tracemalloc and exclude the loaded library and native SQLite allocations.

Writes compare the previous revision's canonical writer with the current one
on real databases, so the current side includes trigger and index upkeep.
Temporary databases live on the repository storage volume.
Run: venv/bin/python scripts/benchmark_local_search_index.py --repeats 5
"""
import argparse
import ast
import gc
import importlib.util
import json
import os
from pathlib import Path
import random
import statistics
import subprocess
import sys
import tempfile
import time
import tracemalloc
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import shared.database as database
from shared import library_search
from shared.database import DatabaseManager
from shared.models import LibraryMetadata, Track
from shared.text_utils import fold_text, match_tokens

QUERIES = {
    "dense": "so",
    "word": "song",
    "artist": "artist 42",
    "title": "song 4242",
    "accent": "album 14",
    "reordered": "14 album",
    "absent": "zzqx",
}


def catalog_module(revision=None):
    name = f"search_benchmark_catalog_{revision or 'current'}"
    spec = importlib.util.spec_from_file_location(name, ROOT / "shared/api/routes/catalog.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    if revision:
        source = subprocess.check_output(["git", "show", f"{revision}:shared/api/routes/catalog.py"], cwd=ROOT, text=True)
        exec(compile(source, spec.origin, "exec"), module.__dict__)
    else:
        spec.loader.exec_module(module)
    return module


def reference_writer(revision):
    """The previous revision's schema setup and canonical save, nothing else."""
    source = subprocess.check_output(["git", "show", f"{revision}:shared/database.py"], cwd=ROOT, text=True)
    cls = next(node for node in ast.parse(source).body if isinstance(node, ast.ClassDef) and node.name == "DatabaseManager")
    methods = [node for node in cls.body if isinstance(node, ast.FunctionDef) and node.name in {"replace_library", "_apply_schema"}]
    scope = dict(vars(database))
    exec(compile(ast.Module(body=methods, type_ignores=[]), "<reference writer>", "exec"), scope)
    return type("ReferenceWriter", (DatabaseManager,), {name: scope[name] for name in ("replace_library", "_apply_schema")})


def library(count):
    rng = random.Random(count)
    return LibraryMetadata(1, [Track(
        id=str(uuid.UUID(int=rng.getrandbits(128), version=4)),
        title=f"Song {i}" + (" (Official Video)" if i % 13 == 0 else ""),
        artist=f"Artist {i // 100}",
        album=f"{'Álbum' if (i // 10) % 7 == 0 else 'Album'} {i // 10}",
        duration=180, file_hash=f"hash{i}", original_filename=f"{i}.mp3",
        compressed=False, file_size=1000, bitrate=320, format="mp3",
    ) for i in range(count)], {}, {})


def timed(function, repeats):
    samples = []
    for _ in range(repeats):
        gc.collect()
        start = time.perf_counter()
        result = function()
        samples.append((time.perf_counter() - start) * 1000)
    return result, round(statistics.median(samples), 2)


def peak(function):
    gc.collect()
    tracemalloc.start()
    function()
    _, value = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    return round(value / 2**20, 3)


def selector(module, tracks):
    module._library_tracks = lambda: tracks
    return lambda query: module._local_catalog(query, 30)


def file_bytes(path):
    return sum(os.path.getsize(f"{path}{suffix}") for suffix in ("", "-wal") if os.path.exists(f"{path}{suffix}"))


def index_bytes(db):
    with db._get_connection() as conn:
        return conn.execute("SELECT COALESCE(SUM(pgsize), 0) FROM dbstat "
                            "WHERE name IN ('library_search', 'library_search_state')").fetchone()[0]


def candidate_count(db, tracks, query):
    """How many tracks the index hands to the ranker for this query."""
    q_folded = fold_text(query)
    with db.library_search_candidates(tracks, q_folded, frozenset(match_tokens(query))) as rows:
        return sum(1 for _ in rows)


def writes(writers, directory, size, repeats):
    """Import, then alternate both writers through the same edits.

    Alternating each repetition keeps drift (WAL growth, cache, thermals) from
    landing on one side only.
    """
    sides = {}
    result = {}
    for name, writer in writers.items():
        path = str(Path(directory) / f"{name}.db")
        metadata = library(size)
        db = writer(path)
        start = time.perf_counter()
        db.replace_library(metadata)
        sides[name] = (db, metadata, path)
        result[name] = {"import_ms": round((time.perf_counter() - start) * 1000, 2)}
    edits = {
        "title": lambda tracks, n: setattr(tracks[n], "title", f"Edited {n}"),
        "append": lambda tracks, n: tracks.append(Track(
            id=f"appended-{n}", title=f"Appended {n}", artist="Artist 1", album="Album 1", duration=180,
            file_hash=f"appended{n}", original_filename="a.mp3", compressed=False, file_size=1, bitrate=320, format="mp3")),
        "duration": lambda tracks, n: setattr(tracks[n], "duration", 181 + n),
        # Every later track moves up one position.
        "remove_middle": lambda tracks, n: tracks.pop(len(tracks) // 2),
    }
    for case, edit in edits.items():
        samples = {name: [] for name in sides}
        for n in range(1, repeats + 1):
            order = list(sides) if n % 2 else list(reversed(sides))
            for name in order:
                db, metadata, _ = sides[name]
                edit(metadata.tracks, n)
                gc.collect()
                start = time.perf_counter()
                db.replace_library(metadata)
                samples[name].append((time.perf_counter() - start) * 1000)
        for name in sides:
            result[name][f"{case}_save_ms"] = round(statistics.median(samples[name]), 2)
    for name, (_, _, path) in sides.items():
        result[name]["db_bytes"] = file_bytes(path)
    return {name: side[:2] for name, side in sides.items()}, result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reference", default="78acb5e")
    parser.add_argument("--sizes", type=int, nargs="+", default=[1000, 10000, 50000])
    parser.add_argument("--repeats", type=int, default=5)
    args = parser.parse_args()
    if args.repeats < 1 or any(size < 1000 for size in args.sizes):
        parser.error("positive repeats and at least 1,000 tracks required")
    previous, current = catalog_module(args.reference), catalog_module()
    used = []
    original = library_search.candidates

    def spy(*args):
        rows = original(*args)
        used.append(rows is not None)
        return rows

    library_search.candidates = spy
    for size in args.sizes:
        with tempfile.TemporaryDirectory(prefix="soundsible-search-", dir=ROOT.parent) as directory:
            sides, result = writes({"before": reference_writer(args.reference), "after": DatabaseManager},
                                   directory, size, args.repeats)
            db, metadata = sides["after"]
            result["after"]["index_bytes"] = index_bytes(db)
            print(json.dumps({"tracks": size, "kind": "writes", **result}), flush=True)

            # A database written by the previous revision gains its index once.
            database._SCHEMA_READY.clear()
            start = time.perf_counter()
            DatabaseManager(str(Path(directory) / "before.db"))
            build_ms = round((time.perf_counter() - start) * 1000, 2)
            print(json.dumps({"tracks": size, "kind": "build", "schema_setup_ms": build_ms}), flush=True)

            tracks = current._LibraryTracks(metadata.tracks)
            tracks.search_db = db
            _, fingerprint_ms = timed(lambda: library_search.model_fingerprint(tracks), args.repeats)
            print(json.dumps({"tracks": size, "kind": "fingerprint", "median_ms": fingerprint_ms}), flush=True)
            plain = list(metadata.tracks)
            selectors = {
                "previous": selector(previous, plain),
                "scan": lambda query: selector(current, plain)(query),
                "indexed": lambda query: selector(current, tracks)(query),
            }
            for name, query in QUERIES.items():
                row = {"tracks": size, "kind": "query", "query": name}
                results = []
                for label, function in selectors.items():
                    calls = len(used)
                    result, median = timed(lambda: function(query), args.repeats)
                    row[label] = {"median_ms": median, "peak_mib": peak(lambda: function(query))}
                    if label == "indexed":
                        assert used[calls:] and all(used[calls:]), "indexed selector did not use the index"
                    results.append(result)
                assert results[0] == results[1] == results[2], (size, name)
                row["results"] = len(results[0])
                row["candidates"] = candidate_count(db, tracks, query)
                print(json.dumps(row), flush=True)


if __name__ == "__main__":
    main()
