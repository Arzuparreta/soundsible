"""The DJ's mixing switch: an account preference that changes how songs meet,
never which songs the DJ picks.
"""

from __future__ import annotations

import pytest

from shared.discovery_intelligence import load_discovery_settings, save_discovery_settings


@pytest.fixture
def client():
    from shared.api import app

    app.config["TESTING"] = True
    with app.test_client() as test_client:
        yield test_client


def test_mixing_is_on_by_default():
    # The DJ mixes unless somebody asked it not to.
    assert load_discovery_settings()["dj_mixing"] is True


def test_the_setting_round_trips_and_leaves_the_others_alone():
    save_discovery_settings({"dj_mixing": False})
    settings = load_discovery_settings()
    assert settings["dj_mixing"] is False
    assert settings["volume_leveling"] is True
    assert settings["autoplay_enabled"] is True
    assert settings["learning_enabled"] is True

    save_discovery_settings({"dj_mixing": True})
    assert load_discovery_settings()["dj_mixing"] is True


def test_patching_the_setting_over_http(client):
    response = client.patch("/api/discovery/settings", json={"dj_mixing": False})
    assert response.status_code == 200
    assert response.get_json()["dj_mixing"] is False

    assert client.get("/api/discovery/settings").get_json()["dj_mixing"] is False


def test_a_non_boolean_is_rejected(client):
    response = client.patch("/api/discovery/settings", json={"dj_mixing": "no"})
    assert response.status_code == 400
    # And nothing was written.
    assert load_discovery_settings()["dj_mixing"] is True


def test_switching_it_keeps_the_personalized_feed(client, monkeypatch):
    # How songs meet has nothing to do with what gets recommended.
    from shared.api.routes import discovery

    invalidated: list[bool] = []
    monkeypatch.setattr(discovery, "_invalidate_personalized_cache", lambda: invalidated.append(True))

    assert client.patch("/api/discovery/settings", json={"dj_mixing": False}).status_code == 200
    assert invalidated == []

    assert client.patch("/api/discovery/settings", json={"autoplay_enabled": False}).status_code == 200
    assert invalidated == [True]
