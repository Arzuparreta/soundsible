"""
Minimal contract tests for core route modules that previously had zero coverage:
library, playback, and downloader.
"""

import hashlib
import uuid
from unittest.mock import MagicMock

from flask import Flask

from shared.api.routes.library import library_bp
from shared.api.routes.playback import playback_bp
from shared.api.routes.downloader import downloader_bp
from shared.database import DatabaseManager
from shared.hardening import ALL_SCOPES
from shared.models import LibraryMetadata, Track
from shared.runtime import RuntimeConfig, configure_runtime, reset_runtime


def _track(track_id: str, title: str, *, artist: str = "Artist", album: str = "Album") -> Track:
    return Track(
        id=track_id,
        title=title,
        artist=artist,
        album=album,
        duration=180,
        file_hash=f"hash-{track_id}",
        original_filename=f"{track_id}.mp3",
        compressed=False,
        file_size=1000,
        bitrate=320,
        format="mp3",
    )


class _FakeLibrary:
    def __init__(self, metadata):
        self.metadata = metadata

    def refresh_if_stale(self):
        return None

    def sync_library(self):
        return True


class _FakeQueueItem:
    def __init__(self, track_id: str):
        self._track_id = track_id

    def to_dict(self):
        return {"track_id": self._track_id, "title": "T"}


class _FakeQueue:
    def __init__(self, items=None):
        self._items = items or []
        self._rev = 1
        self._repeat = "off"

    def get_all(self):
        return self._items

    def get_revision(self):
        return self._rev

    def get_repeat_mode(self):
        return self._repeat

    def set_repeat_mode(self, mode):
        self._repeat = mode

    def shuffle(self):
        pass


def _make_runtime(tmp_path):
    runtime = RuntimeConfig(
        host="127.0.0.1",
        port=5005,
        config_dir=(tmp_path / "cfg").resolve(),
        data_dir=(tmp_path / "data").resolve(),
        cache_dir=(tmp_path / "cache").resolve(),
        log_dir=(tmp_path / "logs").resolve(),
        music_dir=(tmp_path / "music").resolve(),
        ui_dist=None,
        owner_token_file=None,
        lan_enabled=False,
        advanced_mode=True,
    )
    configure_runtime(runtime)
    for path in (runtime.config_dir, runtime.data_dir, runtime.cache_dir, runtime.log_dir):
        path.mkdir(parents=True, exist_ok=True)


def _owner_token(db: DatabaseManager) -> str:
    token = "owner-secret"
    db.create_auth_token(
        str(uuid.uuid4()),
        hashlib.sha256(token.encode("utf-8")).hexdigest(),
        kind="owner",
        scopes=sorted(ALL_SCOPES),
        name="owner",
        device_type="desktop-shell",
    )
    return token


# ---------------------------------------------------------------------------
# Library
# ---------------------------------------------------------------------------

def _patch_library_api(monkeypatch, metadata):
    fake_lib = _FakeLibrary(metadata)

    def fake_get_core():
        return fake_lib, None, None

    def fake_get_track_by_id(lib, track_id):
        return {t.id: t for t in (metadata.tracks or [])}.get(track_id)

    monkeypatch.setattr("shared.api.routes.library._get_api", lambda: {
        "get_core": fake_get_core,
        "get_track_by_id": fake_get_track_by_id,
        "_mark_track_metadata_updated": lambda: None,
        "_ensure_lib_metadata": lambda lib: metadata,
        "socketio": MagicMock(),
        "get_downloader": lambda **kw: MagicMock(),
        "favourites_manager": MagicMock(),
        "is_trusted_network": lambda: True,
        "LibraryMetadata": LibraryMetadata,
    })


def test_library_get_returns_metadata(tmp_path, monkeypatch):
    reset_runtime()
    _make_runtime(tmp_path)
    metadata = LibraryMetadata(
        version=1,
        tracks=[_track("t1", "One")],
        playlists={},
        settings={},
    )
    _patch_library_api(monkeypatch, metadata)

    app = Flask(__name__)
    app.register_blueprint(library_bp)
    client = app.test_client()

    resp = client.get("/api/library")
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["tracks"][0]["id"] == "t1"


def test_library_sync_returns_success(tmp_path, monkeypatch):
    reset_runtime()
    _make_runtime(tmp_path)
    metadata = LibraryMetadata(version=1, tracks=[], playlists={}, settings={})
    _patch_library_api(monkeypatch, metadata)

    app = Flask(__name__)
    app.register_blueprint(library_bp)
    client = app.test_client()
    db = DatabaseManager()
    token = _owner_token(db)

    resp = client.post(
        "/api/library/sync",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    assert resp.get_json()["status"] == "success"


def test_library_favourites_toggle(tmp_path, monkeypatch):
    reset_runtime()
    _make_runtime(tmp_path)
    metadata = LibraryMetadata(
        version=1,
        tracks=[_track("t1", "One")],
        playlists={},
        settings={},
    )
    fav = MagicMock()
    fav.get_all.return_value = ["t1"]
    fav.toggle.return_value = True

    fake_lib = _FakeLibrary(metadata)
    monkeypatch.setattr("shared.api.routes.library._get_api", lambda: {
        "get_core": lambda: (fake_lib, None, None),
        "get_track_by_id": lambda lib, tid: {t.id: t for t in metadata.tracks}.get(tid),
        "socketio": MagicMock(),
        "favourites_manager": fav,
        "is_trusted_network": lambda: True,
    })

    app = Flask(__name__)
    app.register_blueprint(library_bp)
    client = app.test_client()
    db = DatabaseManager()
    token = _owner_token(db)

    resp = client.post(
        "/api/library/favourites/toggle",
        json={"track_id": "t1"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    body = resp.get_json()
    assert "is_favourite" in body
    assert body["is_favourite"] is True


# ---------------------------------------------------------------------------
# Playback
# ---------------------------------------------------------------------------

def _patch_playback_api(monkeypatch, *, queue_items=None, playback_state=None):
    fake_lib = _FakeLibrary(LibraryMetadata(version=1, tracks=[], playlists={}, settings={}))
    fake_queue = _FakeQueue(queue_items or [])
    _devices = {}

    def fake_get_core():
        return fake_lib, None, fake_queue

    def fake_register_device(scope, device_id, device_name, device_type):
        dev = {"device_id": device_id, "device_name": device_name, "device_type": device_type}
        _devices.setdefault(scope, {})[device_id] = dev
        return dev

    def fake_list_devices(scope):
        return list(_devices.get(scope, {}).values())

    monkeypatch.setattr("shared.api.routes.playback._get_api", lambda: {
        "get_core": fake_get_core,
        "get_playback_state": lambda scope: playback_state or {},
        "get_scope_from_request": lambda: "default",
        "get_track_by_id": lambda lib, tid: None,
        "socketio": MagicMock(),
        "register_device": fake_register_device,
        "list_registered_devices": fake_list_devices,
        "is_trusted_network": lambda: True,
    })


def test_playback_queue_returns_snapshot(tmp_path, monkeypatch):
    reset_runtime()
    _make_runtime(tmp_path)
    _patch_playback_api(monkeypatch, queue_items=[_FakeQueueItem("t1")])

    app = Flask(__name__)
    app.register_blueprint(playback_bp)
    client = app.test_client()

    resp = client.get("/api/playback/queue")
    assert resp.status_code == 200
    body = resp.get_json()
    assert "items" in body
    assert "queue_revision" in body
    assert body["repeat_mode"] == "off"


def test_devices_register_and_list(tmp_path, monkeypatch):
    reset_runtime()
    _make_runtime(tmp_path)
    _patch_playback_api(monkeypatch)

    app = Flask(__name__)
    app.register_blueprint(playback_bp)
    client = app.test_client()

    reg = client.post("/api/devices/register", json={
        "device_id": "d1",
        "device_name": "Phone",
        "device_type": "mobile",
    })
    assert reg.status_code == 200
    body = reg.get_json()
    assert body["status"] == "registered"
    assert body["device"]["device_id"] == "d1"

    lst = client.get("/api/devices")
    assert lst.status_code == 200
    devices = lst.get_json()["devices"]
    assert any(d["device_id"] == "d1" for d in devices)


def test_playback_repeat_sets_mode(tmp_path, monkeypatch):
    reset_runtime()
    _make_runtime(tmp_path)
    fake_queue = _FakeQueue()
    fake_lib = _FakeLibrary(LibraryMetadata(version=1, tracks=[], playlists={}, settings={}))
    monkeypatch.setattr("shared.api.routes.playback._get_api", lambda: {
        "get_core": lambda: (fake_lib, None, fake_queue),
        "socketio": MagicMock(),
        "is_trusted_network": lambda: True,
    })

    app = Flask(__name__)
    app.register_blueprint(playback_bp)
    client = app.test_client()

    resp = client.post("/api/playback/repeat", json={"mode": "all"})
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["status"] == "success"
    assert body["mode"] == "all"


# ---------------------------------------------------------------------------
# Downloader
# ---------------------------------------------------------------------------

class _FakeDownloaderWrapper:
    def __init__(self):
        self.downloader = MagicMock()
        self.downloader.search_youtube = lambda q, max_results=10, use_ytmusic=True, enrich_missing=True: [
            {"id": "yt1", "title": q, "artist": "A"}
        ]


def _patch_downloader_api(monkeypatch):
    fake_dl = _FakeDownloaderWrapper()
    fake_svc = MagicMock()
    fake_svc.queue = []
    fake_svc.is_processing = False
    fake_svc.log_buffer = []
    fake_svc.add.return_value = {"id": "dl1"}
    monkeypatch.setattr("shared.api.routes.downloader._get_api", lambda: {
        "get_core": lambda: (_FakeLibrary(LibraryMetadata(version=1, tracks=[], playlists={}, settings={})), None, None),
        "get_downloader": lambda **kw: fake_dl,
        "queue_manager_dl": fake_svc,
        "start_downloader_pump": lambda: None,
        "parse_intake_item": lambda item: (item, None),
        "is_trusted_network": lambda: True,
        "downloader_service": fake_svc,
    })


def test_downloader_queue_add_and_status(tmp_path, monkeypatch):
    reset_runtime()
    _make_runtime(tmp_path)
    _patch_downloader_api(monkeypatch)

    app = Flask(__name__)
    app.register_blueprint(downloader_bp)
    client = app.test_client()
    db = DatabaseManager()
    token = _owner_token(db)

    resp = client.post(
        "/api/downloader/queue",
        json={"items": [{"id": "dl1", "song_str": "test"}]},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    body = resp.get_json()
    assert "queued" in body or "status" in body

    status = client.get("/api/downloader/queue/status")
    assert status.status_code == 200
    body = status.get_json()
    assert "is_processing" in body


def test_downloader_youtube_search_contract(tmp_path, monkeypatch):
    reset_runtime()
    _make_runtime(tmp_path)
    _patch_downloader_api(monkeypatch)

    app = Flask(__name__)
    app.register_blueprint(downloader_bp)
    client = app.test_client()

    resp = client.get("/api/downloader/youtube/search?q=test")
    assert resp.status_code == 200
    body = resp.get_json()
    assert "results" in body
    assert isinstance(body["results"], list)
    if body["results"]:
        assert "id" in body["results"][0]
