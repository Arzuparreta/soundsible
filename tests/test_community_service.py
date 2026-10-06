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


def test_idle_room_releases_its_slot_but_a_playing_one_keeps_it(tmp_path, monkeypatch):
    monkeypatch.setenv("COMMUNITY_DB_PATH", str(tmp_path / "community.db"))
    monkeypatch.setenv("COMMUNITY_ARTWORK_DIR", str(tmp_path / "artwork"))
    monkeypatch.setenv("COMMUNITY_SOCKET_ASYNC_MODE", "threading")
    monkeypatch.setenv("COMMUNITY_IDLE_SESSION_SECONDS", "600")
    import community_service.app as module
    module = importlib.reload(module)
    client = module.app.test_client()

    body = {"title": "Never started", "profile": {"display_name": "DJ Test"}}
    encoded, headers = _headers("POST", "/v1/sessions", body)
    idle = client.post("/v1/sessions", data=encoded, headers=headers).get_json()["session"]
    host = module.socketio.test_client(module.app, auth={
        "session_id": idle["id"],
        "host_token": idle["host_token"],
    })

    # A listener arriving keeps touching updated_at, which must not renew a room
    # that has never played a note.
    guest = module.socketio.test_client(module.app, auth={
        "session_id": idle["id"],
        "guest_id": "guest-idle",
        "guest_name": "Guest-IDLE",
    })
    assert guest.is_connected()

    with module.db() as conn:
        conn.execute(
            "UPDATE sessions SET created_at = ? WHERE id = ?",
            (module._now() - 601, idle["id"]),
        )

    assert client.get("/v1/sessions").get_json()["sessions"] == []
    assert client.get(f"/v1/sessions/{idle['id']}").status_code == 404
    # The DJ is told, rather than left holding a room the directory forgot.
    assert any(event["name"] == "session_ended" for event in host.get_received())
    host.disconnect()
    guest.disconnect()

    encoded, headers = _headers("POST", "/v1/sessions", {"title": "Playing", "profile": {"display_name": "DJ Test"}})
    live = client.post("/v1/sessions", data=encoded, headers=headers).get_json()["session"]
    playing = module.socketio.test_client(module.app, auth={
        "session_id": live["id"],
        "host_token": live["host_token"],
    })
    playing.emit("program_event", {"v": 1, "seq": 1, "transport": "playing"})
    with module.db() as conn:
        conn.execute(
            "UPDATE sessions SET created_at = ? WHERE id = ?",
            (module._now() - 100_000, live["id"]),
        )

    # An eight-hour set is a long set, not an abandoned room.
    assert len(client.get("/v1/sessions").get_json()["sessions"]) == 1
    playing.disconnect()


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
    old_host = module.socketio.test_client(module.app, auth={"session_id": original["id"], "host_token": original["host_token"]})
    with patch.object(module.urllib.request, "urlopen", return_value=io.BytesIO(b'{"source":null}')):
        resumed = client.post(path, data=encoded, headers=headers)

    assert resumed.status_code == 200
    session = resumed.get_json()["session"]
    assert session["id"] == original["id"]
    assert session["host_token"] != original["host_token"]
    assert session["publish_token"] != original["publish_token"]
    assert session["reconnect_grace_seconds"] == 15
    assert not old_host.is_connected()
    delete_path = f"/v1/sessions/{original['id']}"
    stale_body = {"profile": {"display_name": "DJ Test"}, "if_host_token": original["host_token"]}
    encoded, headers = _headers("DELETE", delete_path, stale_body)
    assert client.delete(delete_path, data=encoded, headers=headers).status_code == 409
    assert client.get(delete_path).status_code == 200
    current_body = {**stale_body, "if_host_token": session["host_token"]}
    encoded, headers = _headers("DELETE", delete_path, current_body)
    assert client.delete(delete_path, data=encoded, headers=headers).status_code == 204


def test_resume_preserves_credentials_if_relay_cannot_retire_publisher(tmp_path, monkeypatch):
    monkeypatch.setenv("COMMUNITY_DB_PATH", str(tmp_path / "community.db"))
    monkeypatch.setenv("COMMUNITY_ARTWORK_DIR", str(tmp_path / "artwork"))
    monkeypatch.setenv("COMMUNITY_SOCKET_ASYNC_MODE", "threading")
    import community_service.app as module
    module = importlib.reload(module)
    client = module.app.test_client()
    body = {"title": "Keep current media", "profile": {"display_name": "DJ Test"}}
    encoded, headers = _headers("POST", "/v1/sessions", body)
    original = client.post("/v1/sessions", data=encoded, headers=headers).get_json()["session"]
    encoded, headers = _headers("POST", f"/v1/sessions/{original['id']}/resume", body)
    with patch.object(module.urllib.request, "urlopen", side_effect=OSError("relay unavailable")):
        response = client.post(f"/v1/sessions/{original['id']}/resume", data=encoded, headers=headers)
    assert response.status_code == 503
    assert response.get_json()["code"] == "media_unavailable"
    assert client.post("/internal/media-auth", json={"action": "publish", "path": original["stream_path"], "token": original["publish_token"]}).status_code == 204


def test_retire_publisher_uses_exact_private_path_and_role(monkeypatch):
    import community_service.app as module
    monkeypatch.setattr(module, "MEDIA_HEALTH_URL", "http://relay.internal:9997/v3/config/global/get")
    path = "live_" + "a" * 18
    peer_id = "00000000-0000-0000-0000-000000000001"
    calls = []
    def control(request, timeout):
        calls.append((request.full_url, request.get_method()))
        if "/paths/get/" in request.full_url:
            payload = {"source": {"type": "webRTCSession", "id": peer_id}}
        elif "/webrtcsessions/get/" in request.full_url:
            payload = {"path": path, "state": "publish"}
        else:
            payload = {"status": "ok"}
        assert timeout == 2
        assert not request.has_header("Cookie")
        return io.BytesIO(json.dumps(payload).encode())
    with patch.object(module.urllib.request, "urlopen", side_effect=control):
        module._retire_publisher(path)
    assert calls == [(f"http://relay.internal:9997/v3/paths/get/{path}", "GET"),
                     (f"http://relay.internal:9997/v3/webrtcsessions/get/{peer_id}", "GET"),
                     (f"http://relay.internal:9997/v3/webrtcsessions/kick/{peer_id}", "POST")]


def test_retire_publisher_rejects_changed_path_without_kicking(monkeypatch):
    import community_service.app as module
    monkeypatch.setattr(module, "MEDIA_HEALTH_URL", "http://relay.internal:9997/v3/config/global/get")
    peer_id = "00000000-0000-0000-0000-000000000001"
    responses = [io.BytesIO(json.dumps({"source": {"type": "webRTCSession", "id": peer_id}}).encode()),
                 io.BytesIO(json.dumps({"path": "live_foreign", "state": "publish"}).encode())]
    with patch.object(module.urllib.request, "urlopen", side_effect=responses) as control:
        import pytest
        with pytest.raises(ValueError, match="ownership changed"):
            module._retire_publisher("live_" + "a" * 18)
        assert control.call_count == 2


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
