"""Synthetic audit probes; only a temporary SQLite file is written.

Run from the repository root with:
    venv/bin/python docs/audits/reproduce_resource_review.py

These report current behavior, including known defects, rather than asserting
that the defects must remain. No station configuration or library is loaded.
"""
from pathlib import Path
import json
import statistics
import sys
import tempfile
import threading
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from shared import database
from shared.database import ConnectionPool, DatabaseManager
from shared.models import LibraryMetadata, Track


def payload_probe():
    results = []
    for count in (1000, 10000, 50000):
        tracks = [Track(
            id=str(i), title="Title", artist="Artist", album="Album", duration=240,
            file_hash=str(i), original_filename=f"{i}.mp3", compressed=False,
            file_size=1000000, bitrate=320, format="mp3",
        ) for i in range(count)]
        metadata = LibraryMetadata(version=1, tracks=tracks, playlists={}, settings={})
        elapsed = []
        for _ in range(3):
            start = time.perf_counter()
            payload = json.loads(metadata.to_json())
            wire = json.dumps(payload, separators=(",", ":"))
            elapsed.append((time.perf_counter() - start) * 1000)
        results.append({
            "tracks": count, "median_roundtrip_ms": statistics.median(elapsed),
            "payload_bytes": len(wire.encode()),
        })
    return results


def pool_probes():
    errors = []
    previous_timeout = database._POOL_ACQUIRE_TIMEOUT_SEC
    # Exercise exhaustion without spending ten seconds on an expected timeout.
    database._POOL_ACQUIRE_TIMEOUT_SEC = 0.02
    try:
        with tempfile.TemporaryDirectory(prefix="soundsible-audit-") as directory:
            manager = DatabaseManager(str(Path(directory) / "library.db"))

            def work():
                try:
                    manager.get_library_revision()
                except TimeoutError:
                    errors.append("TimeoutError")

            for _ in range(16):
                thread = threading.Thread(target=work)
                thread.start()
                thread.join()
            workers = {"pool": manager.pool_stats(), "errors": errors}

        def failed_factory():
            raise OSError("synthetic connection creation failure")

        pool = ConnectionPool(failed_factory, 2)
        for _ in range(2):
            try:
                pool.acquire()
            except OSError:
                pass
        return {"finished_unscoped_workers": workers, "failed_factory": pool.stats()}
    finally:
        database._POOL_ACQUIRE_TIMEOUT_SEC = previous_timeout


if __name__ == "__main__":
    print(json.dumps({"payload": payload_probe(), "lifecycle": pool_probes()}, indent=2))
