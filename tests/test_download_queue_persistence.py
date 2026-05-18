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
