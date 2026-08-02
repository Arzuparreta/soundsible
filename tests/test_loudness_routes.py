"""The setting and the two routes around it, plus the guarantee that a broken
loudness cache can never take the library down with it.
"""

from __future__ import annotations

import pytest

from shared.discovery_intelligence import load_discovery_settings, save_discovery_settings
from shared.loudness.store import reset_connections


@pytest.fixture(autouse=True)
def fresh_connections():
    reset_connections()
    yield
    reset_connections()


@pytest.fixture
def client():
    from shared.api import app

    app.config["TESTING"] = True
    with app.test_client() as test_client:
        yield test_client


def test_levelling_is_on_by_default():
    # The whole point is that it works without anybody going looking for it.
    assert load_discovery_settings()["volume_leveling"] is True


def test_the_setting_round_trips():
    save_discovery_settings({"volume_leveling": False})
    assert load_discovery_settings()["volume_leveling"] is False

    save_discovery_settings({"volume_leveling": True})
    assert load_discovery_settings()["volume_leveling"] is True


def test_turning_levelling_off_leaves_the_other_settings_alone():
    save_discovery_settings({"volume_leveling": False})
    settings = load_discovery_settings()
    assert settings["autoplay_enabled"] is True
    assert settings["learning_enabled"] is True


def test_patching_the_setting_over_http(client):
    response = client.patch("/api/discovery/settings", json={"volume_leveling": False})
    assert response.status_code == 200
    assert response.get_json()["volume_leveling"] is False

    assert client.get("/api/discovery/settings").get_json()["volume_leveling"] is False


def test_a_non_boolean_is_rejected(client):
    response = client.patch("/api/discovery/settings", json={"volume_leveling": "yes"})
    assert response.status_code == 400
    # And nothing was written.
    assert load_discovery_settings()["volume_leveling"] is True


def test_status_reports_without_ffmpeg(client):
    response = client.get("/api/loudness/status")
    assert response.status_code == 200
    assert "activity" in response.get_json()


def test_requesting_priority_measurement(client):
    response = client.post("/api/loudness/request", json={"track_ids": ["a", "b"]})
    assert response.status_code == 200
    assert response.get_json()["queued"] == 2


def test_a_malformed_priority_request_is_rejected(client):
    assert client.post("/api/loudness/request", json={"track_ids": "a"}).status_code == 400


def test_a_priority_request_is_capped(client):
    from shared.api.routes.loudness import MAX_REQUEST_IDS

    response = client.post(
        "/api/loudness/request", json={"track_ids": [str(i) for i in range(500)]}
    )
    # A queue lookahead, not a bulk import: anything longer is not about to be
    # heard and belongs to the ordinary sweep.
    assert response.get_json()["queued"] == MAX_REQUEST_IDS


def test_annotation_never_breaks_the_library(monkeypatch):
    from shared.loudness import LoudnessStore

    def explode(self):
        raise RuntimeError("cache is gone")

    monkeypatch.setattr(LoudnessStore, "measured", explode)

    from shared.api.routes.library import annotate_tracks

    tracks = [{"id": "a", "file_hash": "a", "title": "Song"}]
    annotate_tracks(tracks)
    # Levelling is an enhancement; losing it must never cost the listener their
    # library.
    assert tracks[0]["title"] == "Song"
