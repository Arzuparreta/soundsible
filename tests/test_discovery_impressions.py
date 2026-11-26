"""Phase 4 tests: impression fatigue, 2-hop SQLite exploration, and output rotation."""
from __future__ import annotations

from concurrent.futures import Future
import time
from types import SimpleNamespace

import pytest
from flask import Flask

from shared.api.routes import discovery_feed as route
from shared.database import instance_db, user_db
from shared.discovery_browse import build_browse_sections
from shared.discovery_graph_store import impression_fatigue_multiplier
from shared.discovery_intelligence import save_discovery_settings
from shared.models import LibraryMetadata, Track
from shared.providers import deezer


def _artist(aid: int, name: str | None = None, fans: int = 1000) -> dict:
    return {
        "id": aid,
        "name": name or f"Artist {aid}",
        "nb_fan": fans,
        "picture_big": f"https://img.test/{aid}.jpg",
    }


def test_impression_fatigue_curve_interaction_reset_and_debounce():
    db = user_db()
    t0 = 1_700_000_000

    # Continuous exposure cooling curve: 1 / (1 + 0.5 * effective_shows), recovering over half-life.
    assert impression_fatigue_multiplier(None, now=t0) == 1.0
    db.record_discovery_impressions([("deezer:artist:10", "artist")], now=t0, debounce_sec=6 * 3600, force=False)
    # Within 6h debounce, non-forced serve must not increment shown_count.
    db.record_discovery_impressions([("deezer:artist:10", "artist")], now=t0 + 120, debounce_sec=6 * 3600, force=False)
    row = db.get_discovery_impressions(["deezer:artist:10"])["deezer:artist:10"]
    assert row["shown_count"] == 1
    assert impression_fatigue_multiplier(row, now=t0 + 120) == pytest.approx(1.0 / 1.5, rel=1e-4)

    # Explicit refresh forces increment even within the 6h window.
    db.record_discovery_impressions([("deezer:artist:10", "artist")], now=t0 + 180, force=True)
    row = db.get_discovery_impressions(["deezer:artist:10"])["deezer:artist:10"]
    assert row["shown_count"] == 2
    assert impression_fatigue_multiplier(row, now=t0 + 180) == pytest.approx(0.5, rel=1e-4)

    db.record_discovery_impressions([("deezer:artist:10", "artist")], now=t0 + 240, force=True)
    assert impression_fatigue_multiplier(
        db.get_discovery_impressions(["deezer:artist:10"])["deezer:artist:10"],
        now=t0 + 240,
    ) == pytest.approx(1.0 / 2.5, rel=1e-4)

    # Interacting resets fatigue; long elapsed time (40 days) substantially recovers score.
    assert impression_fatigue_multiplier(
        {"shown_count": 5, "last_shown_at": t0, "last_interacted_at": t0},
        now=t0 + 100,
    ) == 1.0
    assert impression_fatigue_multiplier(
        {"shown_count": 5, "last_shown_at": t0, "last_interacted_at": 0},
        now=t0 + 40 * 86400,
    ) > 0.85


def test_2hop_exploration_surfaces_unseen_sqlite_bridges_without_extra_network(monkeypatch):
    # Pre-seed a 2-hop graph in instance.db where Seed (1) -> [HopA(10), HopB(11)] -> ExploreArtist(90) (>=2 paths).
    db = instance_db()
    now_ts = 1_700_000_000
    nodes = [
        {"deezer_artist_id": "1", "name": "Core Seed", "literal_key": "core seed", "folded_key": "core seed", "nb_fan": 50000, "related_synced_at": now_ts, "releases_synced_at": now_ts},
        {"deezer_artist_id": "90", "name": "Hidden Gem", "literal_key": "hidden gem", "folded_key": "hidden gem", "nb_fan": 8000, "related_synced_at": 0, "releases_synced_at": now_ts},
        *[
            {"deezer_artist_id": str(aid), "name": f"Direct Peer {aid}", "literal_key": f"direct peer {aid}", "folded_key": f"direct peer {aid}", "nb_fan": 20000, "related_synced_at": now_ts, "releases_synced_at": now_ts}
            for aid in range(10, 20)
        ],
    ]
    db.upsert_graph_nodes(nodes, now=now_ts)
    # Seed 1 connects to 10 direct peers (enough to fill limit=10 primary slots).
    db.replace_similarity_edges(
        "1",
        "deezer",
        [(str(aid), idx, 1.0 - idx * 0.05) for idx, aid in enumerate(range(10, 20))],
        now_ts,
    )
    # Two distinct 1st-hop peers point to Hidden Gem (90) as 2nd-hop bridge.
    db.replace_similarity_edges("10", "deezer", [("90", 0, 0.9)], now_ts)
    db.replace_similarity_edges("11", "deezer", [("90", 0, 0.8)], now_ts)

    monkeypatch.setattr(deezer, "get", lambda *a, **k: (_ for _ in ()).throw(AssertionError("unexpected network call")))
    body = build_browse_sections(["Core Seed"], limit=10)
    artists = {sec["id"]: sec["items"] for sec in body["browse_sections"]}["artists"]
    assert len(artists) == 10
    assert artists[-1]["title"] == "Hidden Gem"
    assert artists[-1].get("exploration") is True
    assert artists[-1]["reason_artist"] == "Core Seed"

    # Once Hidden Gem has an impression, 2-hop selection must not surface it again.
    body_after = build_browse_sections(
        ["Core Seed"],
        limit=10,
        impressions={"deezer:artist:90": {"shown_count": 1, "last_shown_at": now_ts, "last_interacted_at": 0}},
    )
    artists_after = {sec["id"]: sec["items"] for sec in body_after["browse_sections"]}["artists"]
    assert all(item["title"] != "Hidden Gem" for item in artists_after)


def test_feed_refresh_rotates_recommended_artists_and_tracks_via_impressions_while_ignoring_cold_and_disabled(monkeypatch):
    route._DISCOVERY_FEED_CACHE.clear()
    route._DISCOVERY_FEED_INFLIGHT.clear()

    def get(path, params=None, **kwargs):
        if path == "search/artist":
            return {"data": [_artist(1, "Core Artist", fans=50000)]}
        if path == "artist/1/related":
            return {"data": [_artist(10, "Related Alpha", fans=5000), _artist(11, "Related Beta", fans=4900)]}
        if path == "artist/10/top":
            return {
                "data": [
                    {"id": 1001, "title": "Alpha Song 1", "artist": _artist(10, "Related Alpha")},
                    {"id": 1002, "title": "Alpha Song 2", "artist": _artist(10, "Related Alpha")},
                    {"id": 1003, "title": "Alpha Song 3", "artist": _artist(10, "Related Alpha")},
                ]
            }
        if path == "artist/11/top":
            return {
                "data": [
                    {"id": 1101, "title": "Beta Song 1", "artist": _artist(11, "Related Beta")},
                    {"id": 1102, "title": "Beta Song 2", "artist": _artist(11, "Related Beta")},
                ]
            }
        if path.endswith("/albums"):
            return {"data": []}
        raise AssertionError(path)

    class _SyncExecutor:
        def submit(self, fn, *args, **kwargs):
            fn(*args, **kwargs)
            fut = Future()
            fut.set_result(None)
            return fut

    tracks = [
        Track(
            id="t1",
            title="Core Track",
            artist="Core Artist",
            album="Core LP",
            duration=180,
            file_hash="h1",
            original_filename="1.mp3",
            file_size=100,
            bitrate=320,
            format="mp3",
        )
    ]
    lib = SimpleNamespace(
        metadata=LibraryMetadata(version=1, tracks=tracks, playlists={}, settings={}),
        refresh_if_stale=lambda: None,
    )
    monkeypatch.setattr(deezer, "get", get)
    monkeypatch.setattr(route, "_deezer_json", lambda path, params=None, ttl_sec=None: get(path, params))
    monkeypatch.setattr(
        route,
        "_get_api",
        lambda: {
            "get_library": lambda: lib,
            "favourite_library_ids": lambda: ["t1"],
            "emit_to_user": lambda *a, **kw: None,
        },
    )
    monkeypatch.setattr(route, "_DISCOVERY_FEED_EXECUTOR", _SyncExecutor())

    app = Flask(__name__)
    app.register_blueprint(route.discovery_bp)
    client = app.test_client()

    # Cold popular feeds must never record impressions.
    route._record_feed_impressions(
        {"needs_seed": True, "browse_sections": [{"id": "artists", "popular": True, "items": [{"id": "deezer:artist:999"}]}], "items": []},
        now=1_700_000_000,
        force=True,
    )
    assert user_db().get_discovery_impressions() == {}

    # Learning disabled must also record zero impressions.
    save_discovery_settings({"learning_enabled": False})
    route._record_feed_impressions(
        {"needs_seed": False, "browse_sections": [{"id": "artists", "popular": False, "items": [{"id": "deezer:artist:999"}]}], "items": []},
        now=1_700_000_000,
        force=True,
    )
    assert user_db().get_discovery_impressions() == {}
    save_discovery_settings({"learning_enabled": True})

    # First personalized request populates cache.
    first = client.get("/api/discovery/music/feed?limit=4")
    assert first.status_code == 200
    cached_body = route._DISCOVERY_FEED_CACHE[next(iter(route._DISCOVERY_FEED_CACHE))][2]
    first_artists = [a["title"] for a in dict((s["id"], s["items"]) for s in cached_body["browse_sections"])["artists"]]
    assert first_artists == ["Related Alpha", "Related Beta"]

    # Serving cached personalized feed records debounced impressions.
    served = client.get("/api/discovery/music/feed?limit=4")
    assert served.status_code == 200
    imps = user_db().get_discovery_impressions()
    assert imps["deezer:artist:10"]["shown_count"] == 1

    # Explicitly force-refresh when Related Alpha accumulates more non-interacted shows than Related Beta.
    now_ts = int(time.time())
    for step in range(3):
        user_db().record_discovery_impressions([("deezer:artist:10", "artist")], now=now_ts + step, force=True)
    refreshed = client.get("/api/discovery/music/feed?limit=4&refresh=1")
    assert refreshed.status_code == 200
    after_body = route._DISCOVERY_FEED_CACHE[next(iter(route._DISCOVERY_FEED_CACHE))][2]
    after_artists = [a["title"] for a in dict((s["id"], s["items"]) for s in after_body["browse_sections"])["artists"]]
    assert after_artists[0] == "Related Beta"
    # Track-level impression fatigue also surfaces previously unseen tracks on More like X shelves.
    assert any(item["title"] == "Alpha Song 3" for item in after_body["items"])
