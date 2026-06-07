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

    assert mgr.queue[0]["status"] == "interrupted"
    assert mgr.queue[1]["status"] == "pending"
    data = json.loads(path.read_text(encoding="utf-8"))
    assert data[0]["status"] == "interrupted"


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
