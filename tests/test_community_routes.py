import json

from flask import Flask

from shared.api.routes import community as routes
from tests.conftest import TEST_USER_ID


class _Response:
    ok = True
    status_code = 201
    content = b'{"session":{"id":"session-test"}}'

    @staticmethod
    def json():
        return {"session": {"id": "session-test"}}


class _HealthResponse:
    ok = True
    status_code = 200


class _EmptyResponse:
    ok = True
    status_code = 204
    content = b""


class _InvalidResponse:
    ok = True
    status_code = 200
    content = b"not-json"

    @staticmethod
    def json():
        raise ValueError("invalid json")


def test_station_bridge_exposes_config_and_signs_profile(monkeypatch):
    monkeypatch.setenv("SOUNDSIBLE_COMMUNITY_URL", "https://live.example.test/")
    monkeypatch.setattr(routes, "current_user_id_from_request", lambda: TEST_USER_ID)
    monkeypatch.setattr(routes, "current_user", lambda: {
        "display_name": "DJ Local",
        "avatar_color": "#f97a12",
    })
    called = {}

    def remote(method, url, **kwargs):
        called.update(method=method, url=url, **kwargs)
        return _Response()

    monkeypatch.setattr(routes.requests, "request", remote)
    monkeypatch.setattr(routes.requests, "get", lambda *args, **kwargs: _HealthResponse())
    app = Flask(__name__)
    app.register_blueprint(routes.community_bp)
    client = app.test_client()

    config = client.get("/api/community/config")
    assert config.status_code == 200
    assert config.get_json()["enabled"] is True
    assert config.get_json()["api_url"] == "https://live.example.test"
    assert config.get_json()["source"] == "custom"
    assert config.get_json()["state"] == "available"
    assert config.get_json()["identity"]["community_id"]

    created = client.post("/api/community/sessions", json={"title": "Saturday"})
    assert created.status_code == 201
    assert called["method"] == "POST"
    assert called["url"] == "https://live.example.test/v1/sessions"
    assert json.loads(called["data"]) == {
        "profile": {"avatar_color": "#f97a12", "display_name": "DJ Local"},
        "title": "Saturday",
    }
    assert called["headers"]["X-Soundsible-Signature"]
    assert called["headers"]["X-Soundsible-Community-Id"]


def test_station_bridge_uses_official_service_without_environment(monkeypatch):
    monkeypatch.delenv("SOUNDSIBLE_COMMUNITY_URL", raising=False)
    monkeypatch.delenv("SOUNDSIBLE_COMMUNITY_DISABLED", raising=False)
    monkeypatch.setattr(routes, "current_user_id_from_request", lambda: TEST_USER_ID)
    monkeypatch.setattr(routes.requests, "get", lambda *args, **kwargs: _HealthResponse())
    app = Flask(__name__)
    app.register_blueprint(routes.community_bp)

    response = app.test_client().get("/api/community/config")
    assert response.status_code == 200
    payload = response.get_json()
    assert payload["api_url"] == routes.OFFICIAL_COMMUNITY_URL
    assert payload["enabled"] is True
    assert payload["source"] == "official"
    assert payload["state"] == "available"
    assert payload["identity"]["community_id"]


def test_station_bridge_offers_tailscale_https_origin(monkeypatch):
    monkeypatch.delenv("SOUNDSIBLE_HTTPS_URL", raising=False)
    monkeypatch.setattr(routes, "current_user_id_from_request", lambda: TEST_USER_ID)
    monkeypatch.setattr(routes.requests, "get", lambda *args, **kwargs: _HealthResponse())
    monkeypatch.setattr(
        routes.socket,
        "gethostbyaddr",
        lambda address: ("desktop-ruben.example.ts.net.", [], [address]),
    )
    app = Flask(__name__)
    app.register_blueprint(routes.community_bp)

    payload = app.test_client().get(
        "/api/community/config",
        headers={"Host": "100.91.167.48:5005"},
    ).get_json()

    assert payload["secure_url"] == "https://desktop-ruben.example.ts.net"


def test_station_bridge_can_be_explicitly_disabled(monkeypatch):
    monkeypatch.setenv("SOUNDSIBLE_COMMUNITY_DISABLED", "true")
    monkeypatch.setenv("SOUNDSIBLE_COMMUNITY_URL", "https://ignored.example")
    monkeypatch.setattr(routes, "current_user_id_from_request", lambda: TEST_USER_ID)
    app = Flask(__name__)
    app.register_blueprint(routes.community_bp)

    payload = app.test_client().get("/api/community/config").get_json()
    assert payload == {
        "api_url": None,
        "enabled": False,
        "error": {
            "code": "community_disabled",
            "message": "Community is disabled by this station",
        },
        "identity": None,
        "source": "disabled",
        "state": "disabled",
    }


def test_station_bridge_rejects_non_origin_overrides(monkeypatch):
    monkeypatch.delenv("SOUNDSIBLE_COMMUNITY_DISABLED", raising=False)
    monkeypatch.setattr(routes, "current_user_id_from_request", lambda: TEST_USER_ID)
    app = Flask(__name__)
    app.register_blueprint(routes.community_bp)
    client = app.test_client()

    for value in (
        "http://live.example.test",
        "https://user:secret@live.example.test",
        "https://live.example.test/path",
        "https://live.example.test?query=1",
        "https://live.example.test/#fragment",
    ):
        monkeypatch.setenv("SOUNDSIBLE_COMMUNITY_URL", value)
        payload = client.get("/api/community/config").get_json()
        assert payload["enabled"] is False
        assert payload["source"] == "custom"
        assert payload["state"] == "invalid"
        assert payload["error"]["code"] == "community_invalid_url"


def test_station_bridge_reports_unreachable_relay_and_remote_errors(monkeypatch):
    monkeypatch.delenv("SOUNDSIBLE_COMMUNITY_DISABLED", raising=False)
    monkeypatch.setenv("SOUNDSIBLE_COMMUNITY_URL", "https://live.example.test")
    monkeypatch.setattr(routes, "current_user_id_from_request", lambda: TEST_USER_ID)
    monkeypatch.setattr(routes, "current_user", lambda: {"display_name": "DJ"})
    monkeypatch.setattr(
        routes.requests,
        "get",
        lambda *args, **kwargs: (_ for _ in ()).throw(routes.requests.ConnectionError()),
    )
    app = Flask(__name__)
    app.register_blueprint(routes.community_bp)
    client = app.test_client()

    payload = client.get("/api/community/config").get_json()
    assert payload["enabled"] is True
    assert payload["state"] == "unavailable"
    assert payload["error"]["code"] == "community_unreachable"

    monkeypatch.setattr(
        routes.requests,
        "request",
        lambda *args, **kwargs: (_ for _ in ()).throw(routes.requests.ConnectionError()),
    )
    failed = client.post("/api/community/sessions/example-session/resume")
    assert failed.status_code == 502
    assert failed.get_json()["code"] == "community_unreachable"


def test_station_bridge_accepts_empty_delete_response(monkeypatch):
    monkeypatch.setattr(routes, "current_user_id_from_request", lambda: TEST_USER_ID)
    monkeypatch.setattr(routes, "current_user", lambda: {"display_name": "DJ"})
    monkeypatch.setattr(routes.requests, "request", lambda *args, **kwargs: _EmptyResponse())
    app = Flask(__name__)
    app.register_blueprint(routes.community_bp)

    response = app.test_client().delete("/api/community/sessions/session-test")

    assert response.status_code == 204
    assert response.data == b""


def test_station_bridge_rejects_invalid_success_payload(monkeypatch):
    monkeypatch.setattr(routes, "current_user_id_from_request", lambda: TEST_USER_ID)
    monkeypatch.setattr(routes, "current_user", lambda: {"display_name": "DJ"})
    monkeypatch.setattr(routes.requests, "request", lambda *args, **kwargs: _InvalidResponse())
    app = Flask(__name__)
    app.register_blueprint(routes.community_bp)

    response = app.test_client().post("/api/community/sessions/session-test/resume")

    assert response.status_code == 502
    assert response.get_json()["code"] == "community_invalid_response"
