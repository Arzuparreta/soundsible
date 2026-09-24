import json
from pathlib import Path

from shared.api.download_queue import DownloadQueueManager


def test_download_queue_no_unlink_preserves_pending(tmp_path):
    path = tmp_path / "download_queue.json"
    payload = [
        {"id": "a1", "status": "pending", "song_str": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"},
        {"id": "a2", "status": "completed", "song_str": "https://youtu.be/abc"},
    ]
    path.write_text(json.dumps(payload), encoding="utf-8")

    mgr = DownloadQueueManager(storage_path=path, socketio=None)

    assert len(mgr.queue) == 1
    assert mgr.queue[0]["status"] == "pending"
    assert path.with_name(path.name + ".sqlite.bak").exists()


def test_download_queue_preserves_recording_identity_evidence(tmp_path):
    path = tmp_path / "download_queue.json"
    recording_mbid = "b1a9c0e9-d987-4042-ae91-78d6a3267d69"
    manager = DownloadQueueManager(storage_path=path, socketio=None)
    item = manager.add(
        {
            "song_str": "https://www.youtube.com/watch?v=abcdefghijk",
            "metadata_evidence": {"musicbrainz_id": recording_mbid},
        }
    )

    restored = DownloadQueueManager(storage_path=path, socketio=None)

    assert restored.queue[0]["id"] == item["id"]
    assert restored.queue[0]["metadata_evidence"]["musicbrainz_id"] == recording_mbid


def test_download_queue_inflight_marked_interrupted_on_restart(tmp_path):
    path = tmp_path / "download_queue.json"
    path.write_text(
        json.dumps(
            [
                {"id": "b1", "status": "downloading", "song_str": "https://www.youtube.com/watch?v=test1"},
                {"id": "b2", "status": "pending", "song_str": "https://www.youtube.com/watch?v=test2"},
            ]
        ),
        encoding="utf-8",
    )

    mgr = DownloadQueueManager(storage_path=path, socketio=None)

    # Restart recovers unfinished work without losing its identity.
    assert [i["id"] for i in mgr.queue] == ["b1", "b2"]
    assert mgr.queue[0]["status"] == "pending"
    assert [i["id"] for i in DownloadQueueManager(path).queue] == ["b1", "b2"]


def test_failed_download_preserves_progress_and_adds_stable_error_fields(tmp_path):
    path = tmp_path / "download_queue.json"
    mgr = DownloadQueueManager(storage_path=path, socketio=None)
    item = mgr.add({"song_str": "https://www.youtube.com/watch?v=UFFStB9G4og"})

    mgr.update_status(item["id"], "downloading")
    mgr.update_progress(item["id"], percent=28.6, phase="downloading")
    failed = mgr.update_status(
        item["id"],
        "failed",
        error="ERROR: Got error: 137 bytes read, 10400093 more expected.",
    )

    assert failed["status"] == "failed"
    assert failed["progress_percent"] == 28.6
    assert failed["error_kind"] == "partial_read"
    assert failed["error_message"] == (
        "YouTube closed the connection before the file finished downloading."
    )

    persisted = DownloadQueueManager(path).queue[0]
    assert persisted["progress_percent"] == 28.6
    assert persisted["error_kind"] == "partial_read"


def test_new_download_attempt_clears_previous_error_metadata(tmp_path):
    mgr = DownloadQueueManager(storage_path=tmp_path / "download_queue.json", socketio=None)
    item = mgr.add({"song_str": "https://www.youtube.com/watch?v=UFFStB9G4og"})

    mgr.update_status(item["id"], "failed", error="connection timed out")
    restarted = mgr.update_status(item["id"], "downloading")

    assert "error" not in restarted
    assert "error_kind" not in restarted
    assert "error_message" not in restarted


def test_restart_preserves_failed_and_recovers_interrupted(tmp_path):
    path = tmp_path / "download_queue.json"
    path.write_text(
        json.dumps(
            [
                {"id": "f1", "status": "failed", "song_str": "https://www.youtube.com/watch?v=f1",
                 "progress_percent": 28.6, "error_kind": "partial_read", "error_message": "x"},
                {"id": "i1", "status": "interrupted", "song_str": "https://www.youtube.com/watch?v=i1"},
                {"id": "p1", "status": "pending", "song_str": "https://www.youtube.com/watch?v=p1"},
                {"id": "d1", "status": "downloading", "song_str": "https://www.youtube.com/watch?v=d1"},
            ]
        ),
        encoding="utf-8",
    )

    mgr = DownloadQueueManager(storage_path=path, socketio=None)

    ids = [i["id"] for i in mgr.queue]
    assert ids == ["f1", "i1", "p1", "d1"]
    assert mgr.queue[0]["status"] == "failed"
    assert all(i["status"] == "pending" for i in mgr.queue[1:])

    persisted = DownloadQueueManager(path).queue
    persisted_ids = [i["id"] for i in persisted]
    assert persisted_ids == ids


def test_retry_failed_clears_error_and_resets_progress(tmp_path):
    mgr = DownloadQueueManager(storage_path=tmp_path / "download_queue.json", socketio=None)
    item = mgr.add({"song_str": "https://www.youtube.com/watch?v=ret"})

    mgr.update_status(item["id"], "downloading")
    mgr.update_progress(item["id"], percent=42.0, phase="downloading")
    mgr.update_status(item["id"], "failed", error="connection timed out")

    retried = mgr.retry_failed(item["id"])

    assert retried is not None
    assert retried["status"] == "pending"
    for stale in ("error", "error_kind", "error_message", "progress_percent",
                  "speed", "eta", "phase", "total_bytes"):
        assert stale not in retried, f"expected {stale} to be cleared"

    persisted = DownloadQueueManager(tmp_path / "download_queue.json").queue[0]
    assert persisted["status"] == "pending"
    assert "error_kind" not in persisted


def test_retry_failed_returns_none_for_non_failed(tmp_path):
    mgr = DownloadQueueManager(storage_path=tmp_path / "download_queue.json", socketio=None)
    item = mgr.add({"song_str": "https://www.youtube.com/watch?v=pend"})
    assert mgr.retry_failed(item["id"]) is None


def test_clear_failed_returns_count_and_removes(tmp_path):
    mgr = DownloadQueueManager(storage_path=tmp_path / "download_queue.json", socketio=None)
    f1 = mgr.add({"song_str": "https://www.youtube.com/watch?v=f1"})
    f2 = mgr.add({"song_str": "https://www.youtube.com/watch?v=f2"})
    mgr.add({"song_str": "https://www.youtube.com/watch?v=p1"})
    mgr.update_status(f1["id"], "failed", error="boom")
    mgr.update_status(f2["id"], "failed", error="boom")

    removed = mgr.clear_failed()
    assert removed == 2

    statuses = sorted(i["status"] for i in mgr.queue)
    assert statuses == ["pending"]


def test_claim_is_exclusive_and_cancel_rejects_late_result(tmp_path):
    manager = DownloadQueueManager(tmp_path / 'queue.json')
    item = manager.add({'song_str': 'test'}, user_id='alice')
    claimed = manager.claim(item['id'])
    assert claimed
    assert manager.claim(item['id']) is None
    assert manager.remove_item(item['id'], user_id='bob') is None
    assert manager.active(item['id'], claimed['attempt'])
    manager.remove_item(item['id'], user_id='alice')
    assert not manager.active(item['id'], claimed['attempt'])
    assert manager.checkpoint(item['id'], claimed['attempt'], {'id': 'audio'}) is None
    assert manager.complete(item['id'], claimed['attempt']) is None
    assert DownloadQueueManager(tmp_path / 'queue.json').queue == []


def test_recovery_preserves_result_and_changes_attempt(tmp_path):
    path = tmp_path / 'queue.json'
    first = DownloadQueueManager(path)
    item = first.add({'song_str': 'test'}, user_id='alice')
    claimed = first.claim(item['id'])
    first.checkpoint(item['id'], claimed['attempt'], {'id': 'audio'})
    recovered = DownloadQueueManager(path)
    second = recovered.claim(item['id'])
    assert second['attempt'] != claimed['attempt']
    assert second['result'] == {'id': 'audio'}
    assert 'result' not in recovered.list_items('alice')[0]
    assert first.complete(item['id'], claimed['attempt']) is None


def test_batch_failure_rolls_back_all_acceptances(tmp_path, monkeypatch):
    import sqlite3
    import pytest
    from shared.library_lifecycle import LibraryPersistenceError
    manager = DownloadQueueManager(tmp_path / 'queue.json')
    write = manager._write
    counter = 0
    def fail_second(conn, item):
        nonlocal counter
        counter += 1
        write(conn, item)
        if counter == 2:
            raise sqlite3.OperationalError('disk full')
    monkeypatch.setattr(manager, '_write', fail_second)
    with pytest.raises(LibraryPersistenceError):
        manager.add_many([{'song_str': 'a'}, {'song_str': 'b'}])
    assert manager.queue == []


def test_corrupt_legacy_queue_is_not_replaced(tmp_path):
    import pytest
    from shared.library_lifecycle import LibraryPersistenceError
    path = tmp_path / 'queue.json'
    path.write_text('[truncated')
    with pytest.raises(LibraryPersistenceError):
        DownloadQueueManager(path)
    assert path.read_text() == '[truncated'
    path.write_text('[{"id":"old","status":"pending"}]')
    restored = DownloadQueueManager(path)
    assert restored.queue[0]['id'] == 'old'
    assert DownloadQueueManager(path).queue == restored.queue


def test_progress_does_not_write_sqlite(tmp_path, monkeypatch):
    manager = DownloadQueueManager(tmp_path / 'queue.json')
    item = manager.add({'song_str': 'test'})
    def refuse(*args):
        raise AssertionError('progress wrote durable state')
    monkeypatch.setattr(manager, '_write', refuse)
    for i in range(100):
        manager.update_progress(item['id'], percent=i)
    assert manager.queue[0]['progress_percent'] == 99


def test_process_exit_recovers_checkpoint(tmp_path):
    import os
    import subprocess
    import sys
    path = tmp_path / 'queue.json'
    code = '''
import importlib.util, os, sys
spec = importlib.util.spec_from_file_location('queue_module', 'shared/api/download_queue.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
queue = module.DownloadQueueManager(sys.argv[1])
item = queue.add({'song_str': 'crash'}, user_id='alice')
job = queue.claim(item['id'])
queue.checkpoint(item['id'], job['attempt'], {'id': 'prepared-audio'})
os._exit(23)
'''
    result = subprocess.run([sys.executable, '-c', code, str(path)], env=os.environ.copy(), timeout=20)
    assert result.returncode == 23
    restored = DownloadQueueManager(path)
    assert len(restored.queue) == 1
    job = restored.claim(restored.queue[0]['id'])
    assert job['result']['id'] == 'prepared-audio'
