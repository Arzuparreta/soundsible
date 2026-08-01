import importlib
import io
import json
from unittest.mock import patch

from shared.community_identity import signed_request
from tests.conftest import TEST_USER_ID


def _headers(method, path, body):
    encoded, headers = signed_request(TEST_USER_ID, method, path, body)
    return encoded, headers


def test_session_lifecycle_media_auth_and_no_chat_history(tmp_path, monkeypatch):
    monkeypatch.setenv("COMMUNITY_DB_PATH", str(tmp_path / "community.db"))
    monkeypatch.setenv("COMMUNITY_ARTWORK_DIR", str(tmp_path / "artwork"))
    monkeypatch.setenv("COMMUNITY_SOCKET_ASYNC_MODE", "threading")
    import community_service.app as module
    module = importlib.reload(module)
    client = module.app.test_client()

    body = {"title": "Saturday", "profile": {"display_name": "DJ Test", "avatar_color": "#f97a12"}}
    encoded, headers = _headers("POST", "/v1/sessions", body)
    created = client.post("/v1/sessions", data=encoded, headers=headers)
    assert created.status_code == 201
    session = created.get_json()["session"]
    assert session["status"] == "waiting"

    listing = client.get("/v1/sessions").get_json()["sessions"]
    assert listing[0]["title"] == "Saturday"
    assert "publish_token" not in listing[0]

    assert client.post("/internal/media-auth", json={
        "action": "publish",
        "path": session["stream_path"],
        "token": "wrong",
    }).status_code == 403
    assert client.post("/internal/media-auth", json={
        "action": "publish",
        "path": session["stream_path"],
        "token": session["publish_token"],
    }).status_code == 204

    artwork = client.post(
        f"/v1/sessions/{session['id']}/artwork",
        headers={"Authorization": f"Bearer {session['host_token']}"},
        data={
            "track_id": "track-1",
            "artwork": (io.BytesIO(b"RIFFfake-webp"), "cover.webp", "image/webp"),
        },
        content_type="multipart/form-data",
    )
    assert artwork.status_code == 201
    artwork_url = artwork.get_json()["artwork_url"]
    artwork_path = artwork_url.split(module.PUBLIC_URL, 1)[1]
    assert client.get(artwork_path).data == b"RIFFfake-webp"
    assert client.post("/internal/media-auth", json={
        "action": "read",
        "path": session["stream_path"],
    }).status_code == 204

    guest = module.socketio.test_client(module.app, auth={
        "session_id": session["id"],
        "guest_id": "guest-test",
        "guest_name": "Guest-TEST",
    })
    guest.get_received()
    guest.emit("chat_message", {"text": "pon algo de Burial"})
    assert any(event["name"] == "chat_message" for event in guest.get_received())

    late = module.socketio.test_client(module.app, auth={
        "session_id": session["id"],
        "guest_id": "guest-late",
        "guest_name": "Guest-LATE",
    })
    assert all(event["name"] != "chat_message" for event in late.get_received())

    end_body = {"profile": {"display_name": "DJ Test", "avatar_color": "#f97a12"}}
    encoded, headers = _headers("DELETE", f"/v1/sessions/{session['id']}", end_body)
    ended = client.delete(f"/v1/sessions/{session['id']}", data=encoded, headers=headers)
    assert ended.status_code == 204
    assert client.get("/v1/sessions").get_json()["sessions"] == []
    assert client.get(artwork_path).status_code == 404


def test_capacity_and_one_active_session_per_identity(tmp_path, monkeypatch):
    monkeypatch.setenv("COMMUNITY_DB_PATH", str(tmp_path / "community.db"))
    monkeypatch.setenv("COMMUNITY_ARTWORK_DIR", str(tmp_path / "artwork"))
    monkeypatch.setenv("COMMUNITY_SOCKET_ASYNC_MODE", "threading")
    import community_service.app as module
    module = importlib.reload(module)
    client = module.app.test_client()

    body = {"title": "First", "profile": {"display_name": "DJ Test"}}
    encoded, headers = _headers("POST", "/v1/sessions", body)
    created = client.post("/v1/sessions", data=encoded, headers=headers)
    assert created.status_code == 201
    session = created.get_json()["session"]

    encoded, headers = _headers("POST", "/v1/sessions", body)
    duplicate = client.post("/v1/sessions", data=encoded, headers=headers)
    assert duplicate.status_code == 409
    assert duplicate.get_json()["session_id"] == session["id"]

    monkeypatch.setattr(module, "MAX_SESSION_LISTENERS", 1)
    first = module.socketio.test_client(module.app, auth={
        "session_id": session["id"],
        "guest_id": "guest-first",
        "guest_name": "Guest-ONE",
    })
    assert first.is_connected()
    second = module.socketio.test_client(module.app, auth={
        "session_id": session["id"],
        "guest_id": "guest-second",
        "guest_name": "Guest-TWO",
    })
    assert not second.is_connected()
    first.disconnect()


def test_stale_host_disconnect_cannot_expire_replacement_socket(tmp_path, monkeypatch):
    monkeypatch.setenv("COMMUNITY_DB_PATH", str(tmp_path / "community.db"))
    monkeypatch.setenv("COMMUNITY_ARTWORK_DIR", str(tmp_path / "artwork"))
    monkeypatch.setenv("COMMUNITY_SOCKET_ASYNC_MODE", "threading")
    import community_service.app as module
    module = importlib.reload(module)
    client = module.app.test_client()

    body = {"title": "Handoff", "profile": {"display_name": "DJ Test"}}
    encoded, headers = _headers("POST", "/v1/sessions", body)
    session = client.post("/v1/sessions", data=encoded, headers=headers).get_json()["session"]
    auth = {"session_id": session["id"], "host_token": session["host_token"]}
    first = module.socketio.test_client(module.app, auth=auth)
    second = module.socketio.test_client(module.app, auth=auth)
    first.disconnect()

    assert second.is_connected()
    assert client.get(f"/v1/sessions/{session['id']}").get_json()["session"]["status"] == "waiting"
    second.disconnect()


def test_deleted_session_rejects_late_program_events(tmp_path, monkeypatch):
    monkeypatch.setenv("COMMUNITY_DB_PATH", str(tmp_path / "community.db"))
    monkeypatch.setenv("COMMUNITY_ARTWORK_DIR", str(tmp_path / "artwork"))
    monkeypatch.setenv("COMMUNITY_SOCKET_ASYNC_MODE", "threading")
    import community_service.app as module
    module = importlib.reload(module)
    client = module.app.test_client()

    body = {"title": "Finished", "profile": {"display_name": "DJ Test"}}
    encoded, headers = _headers("POST", "/v1/sessions", body)
    session = client.post("/v1/sessions", data=encoded, headers=headers).get_json()["session"]
    host = module.socketio.test_client(module.app, auth={
        "session_id": session["id"],
        "host_token": session["host_token"],
    })
    host.emit("program_event", {"v": 1, "seq": 1, "transport": "playing"})
    assert module._programs[session["id"]]["seq"] == 1

    path = f"/v1/sessions/{session['id']}"
    delete_body = {"profile": {"display_name": "DJ Test"}}
    encoded, headers = _headers("DELETE", path, delete_body)
    assert client.delete(path, data=encoded, headers=headers).status_code == 204
    host.emit("program_event", {"v": 1, "seq": 2, "transport": "playing"})

    assert session["id"] not in module._programs
    assert client.get(path).status_code == 404


def test_signed_resume_rotates_media_credentials(tmp_path, monkeypatch):
    monkeypatch.setenv("COMMUNITY_DB_PATH", str(tmp_path / "community.db"))
    monkeypatch.setenv("COMMUNITY_ARTWORK_DIR", str(tmp_path / "artwork"))
    monkeypatch.setenv("COMMUNITY_SOCKET_ASYNC_MODE", "threading")
    import community_service.app as module
    module = importlib.reload(module)
    client = module.app.test_client()

    body = {"title": "Recoverable", "profile": {"display_name": "DJ Test"}}
    encoded, headers = _headers("POST", "/v1/sessions", body)
    original = client.post("/v1/sessions", data=encoded, headers=headers).get_json()["session"]
    resume_body = {"profile": {"display_name": "DJ Test"}}
    path = f"/v1/sessions/{original['id']}/resume"
    encoded, headers = _headers("POST", path, resume_body)
    resumed = client.post(path, data=encoded, headers=headers)

    assert resumed.status_code == 200
    session = resumed.get_json()["session"]
    assert session["id"] == original["id"]
    assert session["host_token"] != original["host_token"]
    assert session["publish_token"] != original["publish_token"]
    assert session["reconnect_grace_seconds"] == 90


def test_health_checks_sqlite_and_mediamtx(tmp_path, monkeypatch):
    monkeypatch.setenv("COMMUNITY_DB_PATH", str(tmp_path / "community.db"))
    monkeypatch.setenv("COMMUNITY_ARTWORK_DIR", str(tmp_path / "artwork"))
    monkeypatch.setenv("COMMUNITY_SOCKET_ASYNC_MODE", "threading")
    import community_service.app as module
    module = importlib.reload(module)
    client = module.app.test_client()

    response = type("Health", (), {
        "status": 200,
        "__enter__": lambda self: self,
        "__exit__": lambda self, *args: None,
    })()
    with patch.object(module.urllib.request, "urlopen", return_value=response):
        healthy = client.get("/health")
    assert healthy.status_code == 200
    assert healthy.get_json()["checks"] == {"mediamtx": "ok", "sqlite": "ok"}

    with patch.object(module.urllib.request, "urlopen", side_effect=OSError("offline")):
        unhealthy = client.get("/health")
    assert unhealthy.status_code == 503
    assert unhealthy.get_json()["checks"]["sqlite"] == "ok"
    assert unhealthy.get_json()["checks"]["mediamtx"] == "error"
