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

    assert len(mgr.queue) == 2
    assert mgr.queue[0]["status"] == "pending"
    assert mgr.queue[1]["status"] == "completed"


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

    # Note: a server restart now also evicts interrupted items, so the
    # previous-run in-flight download (downloading -> interrupted) is gone.
    # Only fresh pending work survives.
    assert [i["id"] for i in mgr.queue] == ["b2"]
    assert mgr.queue[0]["status"] == "pending"
    data = json.loads(path.read_text(encoding="utf-8"))
    assert [i["id"] for i in data] == ["b2"]


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

    persisted = json.loads(path.read_text(encoding="utf-8"))[0]
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


def test_restart_evicts_failed_and_interrupted(tmp_path):
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
    assert ids == ["p1"]
    assert mgr.queue[0]["status"] == "pending"

    persisted = json.loads(path.read_text(encoding="utf-8"))
    persisted_ids = [i["id"] for i in persisted]
    assert persisted_ids == ["p1"]


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

    persisted = json.loads((tmp_path / "download_queue.json").read_text(encoding="utf-8"))[0]
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

