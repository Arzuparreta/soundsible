"""Phase 5 / S1 tests: ListenBrainz & Last.fm read-back federation."""
from __future__ import annotations

from concurrent.futures import Future
import time
from types import SimpleNamespace

from flask import Flask
import requests

from shared.api.routes import discovery_feed as route
from shared.database import instance_db
from shared.discovery_federation import clear_federation_cache, sync_federated_signals
from shared.discovery_intelligence import save_discovery_settings
from shared.discovery_profile import ArtistProfileEntry
from shared.models import LibraryMetadata, Track
from shared.providers import deezer
from shared.scrobble.clients import LastFmClient, ListenBrainzClient
from shared.scrobble.service import LASTFM, LISTENBRAINZ, MALOJA
from shared.scrobble.store import ScrobbleStore


def _entry(name: str, deezer_id: str = "") -> ArtistProfileEntry:
    return ArtistProfileEntry(
        artist_key=name.lower(),
        literal_key=name.lower(),
        display_name=name,
        deezer_artist_id=deezer_id,
        short_term_score=2.0,
        long_term_score=2.0,
        library_prior=0.5,
        effective_score=2.5,
        distinct_days=3,
        distinct_tracks=3,
        active_plays=2,
        passive_plays=1,
        early_skips=0,
        last_listened_at=int(time.time()),
        updated_at=int(time.time()),
    )


def _node(aid: str, name: str) -> dict:
    return {
        "deezer_artist_id": aid,
        "name": name,
        "literal_key": name.lower(),
        "folded_key": name.lower(),
        "nb_fan": 50000,
    }


def test_federation_skips_when_learning_disabled_disconnected_or_maloja(monkeypatch):
    clear_federation_cache()

    def boom(*a, **kw):
        raise AssertionError("network request must not happen")

    monkeypatch.setattr(requests, "get", boom)
    monkeypatch.setattr(deezer, "get", boom)

    # Disconnected user -> {}
    assert sync_federated_signals("testuser", [_entry("Boards of Canada")]) == {}

    # Maloja connection -> ListenBrainz client no-ops and no network calls run
    maloja_client = ListenBrainzClient("tok", server="https://maloja.example", maloja=True)
    assert maloja_client.cf_recommendations("alice").data == {"mbids": []}
    assert maloja_client.recording_metadata(["mbid-1"]).data == {"recordings": {}}
    assert maloja_client.fresh_releases("alice").data == {"releases": []}

    store = ScrobbleStore("testuser")
    store.connect(MALOJA, secret="tok", username="alice", server="https://maloja.example")
    store.connect(LISTENBRAINZ, secret="lb-tok", username="alice")
    save_discovery_settings({"learning_enabled": False})
    assert sync_federated_signals("testuser", [_entry("Boards of Canada")]) == {}


def test_lastfm_populates_graph_edges_with_21d_ttl_and_track_similar(monkeypatch):
    clear_federation_cache()
    db = instance_db()
    db.upsert_graph_nodes([_node("10", "Seed Band"), _node("20", "Lastfm Twin")])

    calls = []

    class FakeResp:
        def __init__(self, payload, status_code=200):
            self._payload = payload
            self.status_code = status_code
            self.ok = status_code == 200
            self.headers = {}

        def json(self):
            return self._payload

    def fake_get(url, params=None, **kwargs):
        calls.append((url, params))
        method = (params or {}).get("method")
        if method == "artist.getSimilar":
            return FakeResp({
                "similarartists": {
                    "artist": [{"name": "Lastfm Twin", "match": "0.84", "mbid": "m1"}],
                }
            })
        if method == "track.getSimilar":
            return FakeResp({
                "similartracks": {
                    "track": {"name": "Track Twin", "match": "0.71", "artist": {"name": "Lastfm Twin"}},
                }
            })
        raise AssertionError(url)

    monkeypatch.setattr(requests, "get", fake_get)
    monkeypatch.setenv("SOUNDSIBLE_LASTFM_API_KEY", "k")
    monkeypatch.setenv("SOUNDSIBLE_LASTFM_API_SECRET", "s")
    ScrobbleStore("testuser").connect(LASTFM, secret="sess", username="alice")

    t0 = 1_700_000_000
    assert sync_federated_signals("testuser", [_entry("Seed Band", "10")], now=t0) == {}
    edges = db.get_similarity_edges_for_sources(["10"], providers=["lastfm"])
    assert len(edges) == 1
    assert edges[0]["target_artist_id"] == "20"
    assert edges[0]["weight"] > 0.7

    # Second call within 21d skips Last.fm network call via lastfm_synced_at TTL.
    calls_count = len(calls)
    sync_federated_signals("testuser", [_entry("Seed Band", "10")], now=t0 + 86400)
    assert len(calls) == calls_count

    # Direct track.getSimilar client handles dict single-item Last.fm shape.
    tsim = LastFmClient("k", "s").track_similar("Seed Band", "Seed Track")
    assert tsim.ok
    assert tsim.data["tracks"] == [{"title": "Track Twin", "artist": "Lastfm Twin", "match": 0.71, "mbid": ""}]


def test_listenbrainz_cf_and_fresh_releases_boost_consensus_feed_with_memo_and_isolation(monkeypatch):
    clear_federation_cache()
    route._DISCOVERY_FEED_CACHE.clear()
    route._DISCOVERY_FEED_INFLIGHT.clear()

    db = instance_db()
    db.upsert_graph_nodes([
        _node("10", "Seed Band"),
        _node("20", "Deezer Only"),
        _node("21", "CF + Fresh Boosted"),
    ])

    lb_calls = []

    class FakeResp:
        def __init__(self, payload, status_code=200):
            self._payload = payload
            self.status_code = status_code
            self.ok = status_code == 200
            self.headers = {}

        def json(self):
            return self._payload

    def fake_get(url, params=None, **kwargs):
        lb_calls.append(url)
        if "/1/cf/recommendation/user/" in url:
            return FakeResp({
                "payload": {
                    "mbids": [
                        {"recording_mbid": "rec-1", "score": 0.9},
                    ]
                }
            })
        if "/1/metadata/recording/" in url:
            return FakeResp({
                "rec-1": {
                    "artist": {"artists": [{"artist_mb_name": "CF + Fresh Boosted"}]},
                }
            })
        if "/fresh-releases" in url:
            return FakeResp({
                "payload": {
                    "releases": [
                        {"artist_credit_name": "CF + Fresh Boosted"},
                    ]
                }
            })
        raise AssertionError(url)

    def fake_deezer(path, params=None, **kwargs):
        if path == "search/artist":
            return {"data": [{"id": 10, "name": "Seed Band", "nb_fan": 50000}]}
        if path == "artist/10/related":
            return {
                "data": [
                    {"id": 20, "name": "Deezer Only", "nb_fan": 50000},
                    {"id": 21, "name": "CF + Fresh Boosted", "nb_fan": 50000},
                ]
            }
        if path.endswith("/top") or path.endswith("/albums"):
            return {"data": []}
        raise AssertionError(path)

    class _SyncExecutor:
        def submit(self, fn, *args, **kwargs):
            fn(*args, **kwargs)
            fut = Future()
            fut.set_result(None)
            return fut

    ScrobbleStore("testuser").connect(LISTENBRAINZ, secret="lb-token", username="alice")
    monkeypatch.setattr(requests, "get", fake_get)
    monkeypatch.setattr(deezer, "get", fake_deezer)
    monkeypatch.setattr(route, "_deezer_json", lambda path, params=None, ttl_sec=None: fake_deezer(path, params))
    tracks = [
        Track(
            id="t1",
            title="Track 1",
            artist="Seed Band",
            album="LP",
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
    monkeypatch.setattr(
        route,
        "_get_api",
        lambda: {"get_library": lambda: lib, "favourite_library_ids": lambda: ["t1"], "emit_to_user": lambda *a, **k: None},
    )
    monkeypatch.setattr(route, "_DISCOVERY_FEED_EXECUTOR", _SyncExecutor())

    app = Flask(__name__)
    app.register_blueprint(route.discovery_bp)
    client = app.test_client()
    resp = client.get("/api/discovery/music/feed?limit=6")
    assert resp.status_code == 200

    cached = route._DISCOVERY_FEED_CACHE[next(iter(route._DISCOVERY_FEED_CACHE))][2]
    artists = dict((s["id"], s["items"]) for s in cached["browse_sections"])["artists"]
    # Multi-provider agreement (Deezer + ListenBrainz CF/Fresh) lifts artist 21 to #1.
    assert artists[0]["title"] == "CF + Fresh Boosted"

    # Second federation call hits 6h memo with zero extra HTTP requests.
    prev_lb = len(lb_calls)
    sync_federated_signals("testuser", [_entry("Seed Band", "10")])
    assert len(lb_calls) == prev_lb

    # Upstream errors fail silently without raising or marking needs_reconnect.
    clear_federation_cache()
    monkeypatch.setattr(requests, "get", lambda *a, **kw: (_ for _ in ()).throw(requests.Timeout("timeout")))
    assert sync_federated_signals("testuser", [_entry("Seed Band", "10")]) == {}
    assert ScrobbleStore("testuser").connections()[LISTENBRAINZ]["needs_reconnect"] == 0
