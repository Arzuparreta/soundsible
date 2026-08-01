import json

from flask import Flask

from shared.api.routes import community as routes
from tests.conftest import TEST_USER_ID


class _Response:
    ok = True
    status_code = 201

    @staticmethod
    def json():
        return {"session": {"id": "session-test"}}


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
    app = Flask(__name__)
    app.register_blueprint(routes.community_bp)
    client = app.test_client()

    config = client.get("/api/community/config")
    assert config.status_code == 200
    assert config.get_json()["enabled"] is True
    assert config.get_json()["api_url"] == "https://live.example.test"
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


def test_station_bridge_stays_disabled_without_public_origin(monkeypatch):
    monkeypatch.delenv("SOUNDSIBLE_COMMUNITY_URL", raising=False)
    monkeypatch.setattr(routes, "current_user_id_from_request", lambda: TEST_USER_ID)
    app = Flask(__name__)
    app.register_blueprint(routes.community_bp)

    response = app.test_client().get("/api/community/config")
    assert response.status_code == 200
    assert response.get_json() == {"api_url": None, "enabled": False, "identity": None}
