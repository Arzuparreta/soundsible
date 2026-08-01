import importlib.util
import sys
import threading
import time
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from flask import Flask

from shared.api.memo import Memo
from shared.models import LibraryMetadata, Track
from shared.runtime import RuntimeConfig, configure_runtime, reset_runtime

_ROOT = Path(__file__).resolve().parents[1]
_SPEC = importlib.util.spec_from_file_location("catalog_routes_under_test", _ROOT / "shared/api/routes/catalog.py")
catalog_routes = importlib.util.module_from_spec(_SPEC)
sys.modules["catalog_routes_under_test"] = catalog_routes
_SPEC.loader.exec_module(catalog_routes)
catalog_bp = catalog_routes.catalog_bp


def _make_runtime(tmp_path) -> RuntimeConfig:
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
        advanced_mode=False,
    )
    configure_runtime(runtime)
    for path in (runtime.config_dir, runtime.data_dir, runtime.cache_dir, runtime.log_dir, runtime.music_dir):
        path.mkdir(parents=True, exist_ok=True)
    return runtime


def _make_app():
    app = Flask(__name__)
    app.register_blueprint(catalog_bp)
    return app


class _FakeLibrary:
    def __init__(self, metadata):
        self.metadata = metadata

    def refresh_if_stale(self):
        return None


def _track(track_id: str, title: str, artist: str) -> Track:
    return Track(
        id=track_id,
        title=title,
        artist=artist,
        album="Album",
        duration=180,
        file_hash=f"hash-{track_id}",
        original_filename=f"{track_id}.mp3",
        compressed=False,
        file_size=1000,
        bitrate=320,
        format="mp3",
        youtube_id=f"yt{track_id}".ljust(11, "0")[:11],
    )


def _fake_api(metadata):
    queue = MagicMock()
    queue.is_processing = False
    queue.add.return_value = {"id": "q-1"}
    return {
        "get_core": MagicMock(return_value=(_FakeLibrary(metadata), None, None)),
        "get_downloader": MagicMock(),
        "user_id": "testuser",
        "queue_manager_dl": queue,
        "start_downloader_pump": MagicMock(),
        "parse_intake_item": lambda item: ({**item, "output_dir": None}, None),
    }


@pytest.fixture(autouse=True)
def _reset(tmp_path, monkeypatch):
    reset_runtime()
    _make_runtime(tmp_path)
    catalog_routes._catalog_memo.clear()
    catalog_routes._artist_memo.clear()
    catalog_routes._album_memo.clear()
    yield
    catalog_routes._catalog_memo.clear()
    catalog_routes._artist_memo.clear()
    catalog_routes._album_memo.clear()
    reset_runtime()


def test_catalog_search_combines_local_deezer_and_sections(monkeypatch):
    metadata = LibraryMetadata(version=1, tracks=[_track("local-1", "Rosalia Local", "Rosalia")], playlists={}, settings={})
    monkeypatch.setattr(catalog_routes, "_get_api", lambda: _fake_api(metadata))
    monkeypatch.setattr(
        catalog_routes,
        "_deezer_search",
        lambda q, limit: [
            catalog_routes._catalog_item(
                item_id="deezer:track:10",
                item_type="track",
                source="deezer",
                title="Rosalia Global",
                subtitle="Rosalia",
                artist="Rosalia",
                external_ids={"deezer_id": "10"},
                popularity=900000,
            )
        ],
    )
    monkeypatch.setattr(catalog_routes, "_musicbrainz_search", lambda q, limit: [])

    body = _make_app().test_client().get("/api/catalog/search?q=rosalia").get_json()

    assert body["cached"] is False
    assert body["items"][0]["type"] == "artist"
    assert any(item["type"] == "library_track" for item in body["items"])
    assert any(item["id"] == "deezer:track:10" for item in body["items"])
    assert body["sections"][0]["id"] == "top"
    assert any(section["id"] == "songs" for section in body["sections"])


def test_catalog_search_returns_partial_failures(monkeypatch):
    metadata = LibraryMetadata(version=1, tracks=[], playlists={}, settings={})
    monkeypatch.setattr(catalog_routes, "_get_api", lambda: _fake_api(metadata))
    monkeypatch.setattr(catalog_routes, "_deezer_search", lambda q, limit: (_ for _ in ()).throw(RuntimeError("down")))
    monkeypatch.setattr(catalog_routes, "_musicbrainz_search", lambda q, limit: [])

    body = _make_app().test_client().get("/api/catalog/search?q=queen").get_json()

    assert body["items"] == []
    assert body["partial_failures"] == [{"source": "deezer", "error": "down"}]


def test_catalog_search_uses_public_creator_consensus_without_hiding_literal_results(monkeypatch):
    metadata = LibraryMetadata(version=1, tracks=[], playlists={}, settings={})
    monkeypatch.setattr(catalog_routes, "_get_api", lambda: _fake_api(metadata))
    monkeypatch.setattr(
        catalog_routes,
        "_deezer_search",
        lambda q, limit: [
            catalog_routes._catalog_item(
                item_id="deezer:track:literal",
                item_type="track",
                source="deezer",
                title="Fari",
                artist="Literal Artist",
            )
        ],
    )
    monkeypatch.setattr(catalog_routes, "_musicbrainz_search", lambda q, limit: [])
    monkeypatch.setattr(
        catalog_routes,
        "_youtube_search",
        lambda q, limit: [
            catalog_routes._catalog_item(
                item_id=f"youtube:track:{i}",
                item_type="track",
                source="youtube",
                title=title,
                artist="El Fary",
                raw={"id": str(i), "title": title, "artist": "El Fary"},
            )
            for i, title in enumerate(("El Toro Guapo", "La Mandanga", "Apatrullando la Ciudad"))
        ],
    )

    body = _make_app().test_client().get("/api/catalog/search?q=fari").get_json()

    assert body["interpreted_as"] == "El Fary"
    assert body["items"][0]["artist"] == "El Fary"
    assert any(item["id"] == "deezer:track:literal" for item in body["items"])


def test_catalog_rank_never_uses_library_ownership_for_ties():
    public = catalog_routes._catalog_item(
        item_id="deezer:track:1",
        item_type="track",
        source="deezer",
        title="Neutral Song",
        artist="Neutral Artist",
        in_library=False,
    )
    owned = {**public, "action_state": {**public["action_state"], "in_library": True}}

    assert catalog_routes._rank(public, "neutral song", 0) == catalog_routes._rank(
        owned,
        "neutral song",
        0,
    )


def test_popularity_is_neutral_for_every_source_that_publishes_no_metric():
    """A library row and a MusicBrainz artist row are treated identically.

    The neutral midpoint keys off "this cohort has no popularity signal", never
    off ownership — otherwise the term would smuggle a library boost (or penalty)
    back into a ranking that is contractually query-only.
    """
    rows = [
        catalog_routes._catalog_item(
            item_id="library:track:1", item_type="library_track", source="library",
            title="Song", artist="Artist", in_library=True,
        ),
        catalog_routes._catalog_item(
            item_id="mb:artist:1", item_type="artist", source="musicbrainz", title="Artist",
        ),
        catalog_routes._catalog_item(
            item_id="deezer:track:1", item_type="track", source="deezer",
            title="Song", artist="Artist", popularity=900000,
        ),
        catalog_routes._catalog_item(
            item_id="deezer:track:2", item_type="track", source="deezer",
            title="Song", artist="Artist", popularity=10,
        ),
    ]

    scores = catalog_routes._popularity_scores(rows)

    assert scores["library:track:1"] == scores["mb:artist:1"] == catalog_routes._POPULARITY_NEUTRAL
    assert scores["deezer:track:1"] == catalog_routes._POPULARITY_MAX
    assert scores["deezer:track:2"] == 0.0


def test_popularity_gives_equal_raw_values_equal_scores():
    rows = [
        catalog_routes._catalog_item(
            item_id=f"deezer:track:{i}", item_type="track", source="deezer",
            title="Song", artist="Artist", popularity=pop,
        )
        for i, pop in enumerate((500, 500, 1))
    ]

    scores = catalog_routes._popularity_scores(rows)

    assert scores["deezer:track:0"] == scores["deezer:track:1"]
    assert scores["deezer:track:0"] > scores["deezer:track:2"]


def test_title_score_prefers_the_title_the_query_nearly_fills():
    q, tokens = "radio", frozenset({"radio"})

    def score(title):
        return catalog_routes._text_score(
            q, tokens, title,
            catalog_routes._TITLE_EXACT, catalog_routes._TITLE_PREFIX, catalog_routes._TITLE_CONTAINS,
            apply_coverage=True,
        )

    assert score("Radio") == catalog_routes._TITLE_EXACT
    assert score("Radio") > score("Radiohead") > score("Radiohead - Creep Forever And Ever")
    # Provider boilerplate must not manufacture a penalty.
    assert score("Radiohead (Official Video) [HD]") == score("Radiohead")


def test_text_score_folds_accents_and_accepts_reordered_tokens():
    def score(query, title):
        return catalog_routes._text_score(
            catalog_routes.fold_text(query),
            frozenset(catalog_routes.match_tokens(query)),
            title,
            catalog_routes._TITLE_EXACT, catalog_routes._TITLE_PREFIX, catalog_routes._TITLE_CONTAINS,
            apply_coverage=False,
        )

    assert score("jose", "José") == catalog_routes._TITLE_EXACT
    assert score("rainbows in", "In Rainbows") == catalog_routes._TITLE_CONTAINS
    assert score("nothing alike", "In Rainbows") == 0.0


def _entity_search(monkeypatch, *, deezer=(), musicbrainz=(), youtube=(), tracks=()):
    metadata = LibraryMetadata(version=1, tracks=list(tracks), playlists={}, settings={})
    monkeypatch.setattr(catalog_routes, "_get_api", lambda: _fake_api(metadata))
    monkeypatch.setattr(catalog_routes, "_deezer_search", lambda q, limit: list(deezer))
    monkeypatch.setattr(catalog_routes, "_musicbrainz_search", lambda q, limit: list(musicbrainz))
    monkeypatch.setattr(catalog_routes, "_youtube_search", lambda q, limit: list(youtube))
    return lambda query: _make_app().test_client().get(f"/api/catalog/search?q={query}").get_json()


def _deezer_artist_rows(name: str, songs: list[str]) -> list[dict]:
    rows = [
        catalog_routes._catalog_item(
            item_id=f"deezer:artist:{name}", item_type="artist", source="deezer",
            title=name, subtitle="Artist", artist=name,
            external_ids={"deezer_artist_id": name},
        )
    ]
    rows += [
        catalog_routes._catalog_item(
            item_id=f"deezer:track:{i}", item_type="track", source="deezer",
            title=title, subtitle=name, artist=name, album="Some Album",
            popularity=900000 - i, external_ids={"deezer_id": str(i)},
        )
        for i, title in enumerate(songs)
    ]
    return rows


def test_artist_name_query_leads_with_the_artist_not_their_songs(monkeypatch):
    """The complaint this whole rewrite exists for.

    Under the old scoring a YouTube row for `Radiohead - Creep` tied the artist
    row exactly — 70 (title prefix) + 48 (artist exact) + 12 + **25** = 155 for
    the song, 100 + 48 + 7 + **0** = 155 for the artist — and the merge order
    broke the tie in the song's favour.
    """
    songs = ["Creep", "Karma Police", "No Surprises", "Nude", "Bodysnatchers"]
    search = _entity_search(
        monkeypatch,
        deezer=[
            *_deezer_artist_rows("Radiohead", songs),
            catalog_routes._catalog_item(
                item_id="deezer:artist:tribute", item_type="artist", source="deezer",
                title="Radiohead Tribute Band", subtitle="Artist", artist="Radiohead Tribute Band",
                external_ids={"deezer_artist_id": "tribute"},
            ),
        ],
        youtube=[
            catalog_routes._catalog_item(
                item_id=f"youtube:track:{i}", item_type="track", source="youtube",
                title=f"Radiohead - {title} (Official Video)", subtitle="Radiohead",
                artist="Radiohead", popularity=50_000_000,
                external_ids={"youtube_id": f"yt{i}"}, playable=True,
            )
            for i, title in enumerate(songs)
        ],
    )

    body = search("radiohead")

    assert body["items"][0]["type"] == "artist"
    assert body["top_result"] == "deezer:artist:Radiohead"
    assert body["sections"][0]["id"] == "top"
    # The artist that *is* the answer becomes the hero card, so what is left in
    # the Artists rail is tribute acts — songs deserve to come first. The rail
    # only outranks songs when the query names something the hero did not take,
    # which is what the album test covers.
    assert [s["id"] for s in body["sections"][1:3]] == ["songs", "artists"]
    assert body["sections"][2]["item_ids"] == ["deezer:artist:tribute"]


def test_song_title_query_leads_with_songs(monkeypatch):
    search = _entity_search(
        monkeypatch,
        deezer=[
            catalog_routes._catalog_item(
                item_id="deezer:track:1", item_type="track", source="deezer",
                title="Karma Police", subtitle="Radiohead", artist="Radiohead",
                duration=261, popularity=900000, external_ids={"deezer_id": "1"},
            ),
            catalog_routes._catalog_item(
                item_id="deezer:track:2", item_type="track", source="deezer",
                title="Karma Police (Live In Praha)", subtitle="Radiohead", artist="Radiohead",
                duration=300, popularity=1000, external_ids={"deezer_id": "2"},
            ),
            catalog_routes._catalog_item(
                item_id="deezer:artist:1", item_type="artist", source="deezer",
                title="Radiohead", subtitle="Artist", artist="Radiohead",
                external_ids={"deezer_artist_id": "1"},
            ),
        ],
    )

    body = search("karma%20police")

    assert body["top_result"] == "deezer:track:1"
    assert [s["id"] for s in body["sections"][:2]] == ["top", "songs"]


def test_album_name_query_leads_with_the_album(monkeypatch):
    search = _entity_search(
        monkeypatch,
        deezer=[
            catalog_routes._catalog_item(
                item_id="deezer:album:1", item_type="album", source="deezer",
                title="In Rainbows", subtitle="Radiohead", artist="Radiohead", album="In Rainbows",
                external_ids={"deezer_album_id": "1"},
            ),
            catalog_routes._catalog_item(
                item_id="deezer:album:2", item_type="album", source="deezer",
                title="In Rainbows Disk 2", subtitle="Radiohead", artist="Radiohead",
                album="In Rainbows Disk 2", external_ids={"deezer_album_id": "2"},
            ),
            *[
                catalog_routes._catalog_item(
                    item_id=f"deezer:track:{i}", item_type="track", source="deezer",
                    title=title, subtitle="Radiohead", artist="Radiohead", album="In Rainbows",
                    popularity=900000, external_ids={"deezer_id": str(i)},
                )
                for i, title in enumerate(("15 Step", "Bodysnatchers", "Nude", "Reckoner"))
            ],
        ],
    )

    body = search("in%20rainbows")

    assert body["top_result"] == "deezer:album:1"
    assert [s["id"] for s in body["sections"][:2]] == ["top", "albums"]


def test_no_top_result_when_nothing_matches_confidently(monkeypatch):
    """Better no hero card than a wrong one — it is the biggest target on the page."""
    search = _entity_search(
        monkeypatch,
        deezer=[
            catalog_routes._catalog_item(
                item_id="deezer:track:1", item_type="track", source="deezer",
                title="Something Else Entirely", subtitle="Another Band", artist="Another Band",
                external_ids={"deezer_id": "1"},
            )
        ],
    )

    body = search("qwertzuiop")

    assert body["top_result"] is None
    assert all(section["id"] != "top" for section in body["sections"])


def test_no_top_result_when_a_type_boost_alone_decided_the_winner(monkeypatch):
    """An album and an artist both named exactly the query is not evidence."""
    search = _entity_search(
        monkeypatch,
        deezer=[
            catalog_routes._catalog_item(
                item_id="deezer:artist:1", item_type="artist", source="deezer",
                title="Ambiguous", subtitle="Artist", artist="Ambiguous",
                external_ids={"deezer_artist_id": "1"},
            ),
            catalog_routes._catalog_item(
                item_id="deezer:album:1", item_type="album", source="deezer",
                title="Ambiguous", subtitle="Ambiguous", artist="Ambiguous", album="Ambiguous",
                external_ids={"deezer_album_id": "1"},
            ),
        ],
    )

    body = search("ambiguous")

    assert body["top_result"] is None


def test_owned_song_collapses_with_its_public_copies_without_moving_up(monkeypatch):
    search = _entity_search(
        monkeypatch,
        tracks=[_track("local-1", "Karma Police", "Radiohead")],
        deezer=[
            catalog_routes._catalog_item(
                item_id="deezer:track:1", item_type="track", source="deezer",
                title="Karma Police", subtitle="Radiohead", artist="Radiohead",
                duration=180, popularity=900000, external_ids={"deezer_id": "1"},
            )
        ],
    )

    body = search("karma%20police")
    songs = [item for item in body["items"] if item["type"] in ("track", "library_track")]

    assert len(songs) == 1, "the same recording must not be listed once per provider"
    assert songs[0]["action_state"]["in_library"] is True
    assert songs[0]["action_state"]["playable"] is True
    assert songs[0]["track_id"] == "local-1"


def test_a_different_cut_of_the_same_title_stays_separate(monkeypatch):
    """Twelve minutes of live version is not the three-minute studio take."""
    search = _entity_search(
        monkeypatch,
        tracks=[_track("local-1", "Karma Police", "Radiohead")],
        deezer=[
            catalog_routes._catalog_item(
                item_id="deezer:track:1", item_type="track", source="deezer",
                title="Karma Police", subtitle="Radiohead", artist="Radiohead",
                duration=720, popularity=900000, external_ids={"deezer_id": "1"},
            )
        ],
    )

    body = search("karma%20police")
    songs = [item for item in body["items"] if item["type"] in ("track", "library_track")]

    assert len(songs) == 2


def test_ranking_is_identical_whatever_order_the_providers_finish_in(monkeypatch):
    rows = _deezer_artist_rows("Radiohead", ["Creep", "Nude", "Reckoner"])
    metadata = LibraryMetadata(version=1, tracks=[], playlists={}, settings={})
    monkeypatch.setattr(catalog_routes, "_get_api", lambda: _fake_api(metadata))
    monkeypatch.setattr(catalog_routes, "_musicbrainz_search", lambda q, limit: [])
    monkeypatch.setattr(catalog_routes, "_youtube_search", lambda q, limit: [])

    orders = []
    for shuffled in (rows, list(reversed(rows))):
        catalog_routes._catalog_memo.clear()
        monkeypatch.setattr(catalog_routes, "_deezer_search", lambda q, limit, r=shuffled: list(r))
        body = _make_app().test_client().get("/api/catalog/search?q=radiohead").get_json()
        orders.append([item["id"] for item in body["items"]])

    assert orders[0] == orders[1]


def test_local_catalog_finds_the_artist_behind_a_wall_of_their_own_songs(monkeypatch):
    """The old shared budget stopped scanning before ever reaching this row."""
    metadata = LibraryMetadata(
        version=1,
        tracks=[_track(f"t{i}", f"Song {i}", "Rosalia") for i in range(200)],
        playlists={},
        settings={},
    )
    monkeypatch.setattr(catalog_routes, "_get_api", lambda: _fake_api(metadata))

    rows = catalog_routes._local_catalog("rosalia", 30)

    assert any(row["type"] == "artist" and row["title"] == "Rosalia" for row in rows)


def test_local_catalog_does_not_match_across_field_boundaries(monkeypatch):
    """`"title artist album"` joined together used to match a query spanning two."""
    metadata = LibraryMetadata(
        version=1,
        tracks=[_track("t1", "Closer", "Nine Inch Nails")],
        playlists={},
        settings={},
    )
    monkeypatch.setattr(catalog_routes, "_get_api", lambda: _fake_api(metadata))

    assert catalog_routes._local_catalog("closer nine", 30) == []
    assert catalog_routes._local_catalog("closer", 30)


def test_catalog_save_confirmed_video_queues_download(monkeypatch):
    metadata = LibraryMetadata(version=1, tracks=[], playlists={}, settings={})
    fake_api = _fake_api(metadata)
    monkeypatch.setattr(catalog_routes, "_get_api", lambda: fake_api)

    res = _make_app().test_client().post(
        "/api/catalog/save",
        json={"artist": "Queen", "title": "Bohemian Rhapsody", "confirm_video_id": "abcdefghijk"},
    )

    body = res.get_json()
    assert res.status_code == 200
    assert body["status"] == "queued"
    assert body["video_id"] == "abcdefghijk"
    fake_api["queue_manager_dl"].add.assert_called_once()
    fake_api["start_downloader_pump"].assert_called_once()


def test_resolve_candidates_warms_preview_stream_cache_for_best_id(monkeypatch, tmp_path):
    """After catalog resolve picks a best video id, it queues that id's
    stream-URL resolution in the *background* so the click that follows finds it
    warm (or joins the extraction already running) instead of starting a second
    one. The resolve response itself must not block on that warm-up."""
    catalog_routes._resolve_memo.clear()
    metadata = LibraryMetadata(version=1, tracks=[], playlists={}, settings={})
    fake_api = _fake_api(metadata)
    fake_dl = MagicMock()
    fake_dl.downloader.search_match_candidates.return_value = [
        {
            "id": "abcdefghijk",
            "title": "Bohemian Rhapsody",
            "duration": 354,
            "thumbnail": "https://img.youtube.com/vi/abcdefghijk/mqdefault.jpg",
            "webpage_url": "https://www.youtube.com/watch?v=abcdefghijk",
            "channel": "Queen",
            "artist": "Queen",
        }
    ]
    fake_dl.downloader.get_stream_url.return_value = "https://rr.googlevideo.com/warmed-url"
    fake_api["get_downloader"] = MagicMock(return_value=fake_dl)
    monkeypatch.setattr(catalog_routes, "_get_api", lambda: fake_api)

    prefetched = []

    def fake_request_prefetch(video_ids, *, download, resolver):
        prefetched.append((list(video_ids), download))
        return list(video_ids)

    monkeypatch.setattr("shared.preview_cache.request_prefetch", fake_request_prefetch)

    best, ranked = catalog_routes._resolve_candidates("Queen", "Bohemian Rhapsody", 354)

    assert best["id"] == "abcdefghijk"
    assert best["confidence"] > 0
    assert prefetched == [(["abcdefghijk"], False)]
    # The warm runs on the prefetch worker, so the request thread never blocks
    # on a second yt-dlp extraction.
    fake_dl.downloader.get_stream_url.assert_not_called()


def test_resolve_candidates_skips_warm_on_db_cache_hit(monkeypatch, tmp_path):
    """When resolution is already cached in the DB, the resolve short-circuits
    and must NOT trigger an extra yt-dlp call — the warm is a cold-path-only
    optimization. The first click falls back to the playback cold path, which
    is fine and self-warms on its own."""
    catalog_routes._resolve_memo.clear()
    fake_db = MagicMock()
    cached_row = {
        "id": "cachedvideo_01",
        "title": "Cached Track",
        "duration": 200,
        "thumbnail": "https://example.test/x.jpg",
        "webpage_url": "https://www.youtube.com/watch?v=cachedvideo_01",
        "channel": "Artist",
        "confidence": 0.9,
        "confidence_reason": "title",
        "candidates": [],
    }
    fake_db.get_cached_resolution.return_value = cached_row
    monkeypatch.setattr(catalog_routes, "instance_db", lambda: fake_db)

    fake_api = _fake_api(LibraryMetadata(version=1, tracks=[], playlists={}, settings={}))
    monkeypatch.setattr(catalog_routes, "_get_api", lambda: fake_api)

    best, ranked = catalog_routes._resolve_candidates("Artist", "Cached Track", 200)

    assert best["id"] == "cachedvideo_01"
    fake_api["get_downloader"].assert_not_called()


# ── Artist & Album profile endpoint tests ──────────────────────────────────


def _track_full(track_id: str, title: str, artist: str, album: str = "Album") -> Track:
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
        youtube_id=f"yt{track_id}".ljust(11, "0")[:11],
    )


def _mock_deezer_artist_top(artist_id, limit=50, library_keys=None):
    return [
        catalog_routes._catalog_item(
            item_id="deezer:track:101",
            item_type="track",
            source="deezer",
            title="Gecko",
            subtitle="Oliver Heldens",
            artist="Oliver Heldens",
            external_ids={"deezer_id": "101"},
            popularity=800000,
        ),
    ]


def _mock_deezer_artist_releases(artist_id, limit=100):
    return {
        "albums": [
            {"deezer_id": "201", "title": "Heldeep Sessions", "cover": "http://x/201.jpg", "year": 2020, "record_type": "album"},
        ],
        "singles_eps": [
            {"deezer_id": "202", "title": "Gecko", "cover": "http://x/202.jpg", "year": 2014, "record_type": "single"},
        ],
    }


def _mock_deezer_related(artist_id, limit=20):
    return [
        {"deezer_id": "301", "name": "Tchami", "picture": "http://x/301.jpg", "nb_fans": 500000},
    ]


def _mock_deezer_artist_profile(artist_id):
    return {"name": "Oliver Heldens", "picture": "http://x/oh.jpg", "nb_fans": 1200000}


def _mock_resolve_artist_id(name, deezer_id=None):
    if deezer_id:
        return deezer_id, []
    return "27", []


def _mock_resolve_artist_id_ambiguous(name, deezer_id=None):
    if deezer_id:
        return deezer_id, []
    return "27", [
        {"deezer_id": "99", "name": "Nirvana", "picture": "", "nb_fans": 100, "nb_album": 2},
    ]


def test_artist_endpoint_with_deezer_id(monkeypatch):
    metadata = LibraryMetadata(version=1, tracks=[], playlists={}, settings={})
    monkeypatch.setattr(catalog_routes, "_get_api", lambda: _fake_api(metadata))
    monkeypatch.setattr(catalog_routes, "_resolve_artist_id", _mock_resolve_artist_id)
    monkeypatch.setattr(catalog_routes, "_deezer_artist_profile", _mock_deezer_artist_profile)
    monkeypatch.setattr(catalog_routes, "_deezer_artist_top_tracks", _mock_deezer_artist_top)
    monkeypatch.setattr(catalog_routes, "_deezer_artist_releases", _mock_deezer_artist_releases)
    monkeypatch.setattr(catalog_routes, "_deezer_related_artists", _mock_deezer_related)

    body = _make_app().test_client().get("/api/catalog/artist?name=Oliver+Heldens&deezer_id=27").get_json()

    assert body["resolved"] is True
    assert body["deezer_id"] == "27"
    assert body["metadata"]["name"] == "Oliver Heldens"
    assert body["metadata"]["nb_fans"] == 1200000
    assert len(body["top_tracks"]) == 1
    assert body["top_tracks"][0]["title"] == "Gecko"
    assert len(body["albums"]) == 1
    assert len(body["related_artists"]) == 1
    assert body["related_artists"][0]["name"] == "Tchami"
    assert body["in_library"] is False
    assert body["cached"] is False


def test_artist_endpoint_by_name_only(monkeypatch):
    metadata = LibraryMetadata(version=1, tracks=[], playlists={}, settings={})
    monkeypatch.setattr(catalog_routes, "_get_api", lambda: _fake_api(metadata))
    monkeypatch.setattr(catalog_routes, "_resolve_artist_id", _mock_resolve_artist_id)
    monkeypatch.setattr(catalog_routes, "_deezer_artist_profile", _mock_deezer_artist_profile)
    monkeypatch.setattr(catalog_routes, "_deezer_artist_top_tracks", _mock_deezer_artist_top)
    monkeypatch.setattr(catalog_routes, "_deezer_artist_releases", _mock_deezer_artist_releases)
    monkeypatch.setattr(catalog_routes, "_deezer_related_artists", _mock_deezer_related)

    body = _make_app().test_client().get("/api/catalog/artist?name=Oliver+Heldens").get_json()

    assert body["resolved"] is True
    assert body["deezer_id"] == "27"
    assert body["candidates"] == []


def test_artist_endpoint_ambiguous_name(monkeypatch):
    metadata = LibraryMetadata(version=1, tracks=[], playlists={}, settings={})
    monkeypatch.setattr(catalog_routes, "_get_api", lambda: _fake_api(metadata))
    monkeypatch.setattr(catalog_routes, "_resolve_artist_id", _mock_resolve_artist_id_ambiguous)
    monkeypatch.setattr(catalog_routes, "_deezer_artist_profile", _mock_deezer_artist_profile)
    monkeypatch.setattr(catalog_routes, "_deezer_artist_top_tracks", _mock_deezer_artist_top)
    monkeypatch.setattr(catalog_routes, "_deezer_artist_releases", _mock_deezer_artist_releases)
    monkeypatch.setattr(catalog_routes, "_deezer_related_artists", _mock_deezer_related)

    body = _make_app().test_client().get("/api/catalog/artist?name=Nirvana").get_json()

    assert body["resolved"] is True
    assert body["deezer_id"] == "27"
    assert len(body["candidates"]) == 1
    assert body["candidates"][0]["deezer_id"] == "99"


def test_artist_endpoint_not_in_deezer(monkeypatch):
    metadata = LibraryMetadata(version=1, tracks=[_track_full("local-1", "Local Song", "Obscure Artist")], playlists={}, settings={})
    monkeypatch.setattr(catalog_routes, "_get_api", lambda: _fake_api(metadata))
    monkeypatch.setattr(catalog_routes, "_resolve_artist_id", lambda name, deezer_id=None: (None, []))
    monkeypatch.setattr(catalog_routes, "_deezer_artist_profile", _mock_deezer_artist_profile)
    monkeypatch.setattr(catalog_routes, "_deezer_artist_top_tracks", _mock_deezer_artist_top)

    body = _make_app().test_client().get("/api/catalog/artist?name=Obscure+Artist").get_json()

    assert body["resolved"] is False
    assert body["deezer_id"] is None
    assert body["top_tracks"] == []
    assert body["albums"] == []
    assert body["singles_eps"] == []
    assert body["in_library"] is True


def test_artist_endpoint_caching(monkeypatch):
    metadata = LibraryMetadata(version=1, tracks=[], playlists={}, settings={})
    monkeypatch.setattr(catalog_routes, "_get_api", lambda: _fake_api(metadata))
    monkeypatch.setattr(catalog_routes, "_resolve_artist_id", _mock_resolve_artist_id)
    monkeypatch.setattr(catalog_routes, "_deezer_artist_profile", _mock_deezer_artist_profile)
    monkeypatch.setattr(catalog_routes, "_deezer_artist_top_tracks", _mock_deezer_artist_top)
    monkeypatch.setattr(catalog_routes, "_deezer_artist_releases", _mock_deezer_artist_releases)
    monkeypatch.setattr(catalog_routes, "_deezer_related_artists", _mock_deezer_related)

    client = _make_app().test_client()
    body1 = client.get("/api/catalog/artist?name=Oliver+Heldens").get_json()
    body2 = client.get("/api/catalog/artist?name=Oliver+Heldens").get_json()

    assert body1["cached"] is False
    assert body2["cached"] is True


def test_artist_endpoint_in_library_badge(monkeypatch):
    metadata = LibraryMetadata(version=1, tracks=[_track_full("local-1", "Gecko", "Oliver Heldens")], playlists={}, settings={})
    monkeypatch.setattr(catalog_routes, "_get_api", lambda: _fake_api(metadata))
    monkeypatch.setattr(catalog_routes, "_resolve_artist_id", _mock_resolve_artist_id)
    monkeypatch.setattr(catalog_routes, "_deezer_artist_profile", _mock_deezer_artist_profile)

    def top_with_library(artist_id, limit=50, library_keys=None):
        item = catalog_routes._catalog_item(
            item_id="deezer:track:101",
            item_type="track",
            source="deezer",
            title="Gecko",
            subtitle="Oliver Heldens",
            artist="Oliver Heldens",
            external_ids={"deezer_id": "101"},
            in_library=("oliver heldens\x00gecko" in (library_keys or set())),
        )
        return [item]

    monkeypatch.setattr(catalog_routes, "_deezer_artist_top_tracks", top_with_library)
    monkeypatch.setattr(catalog_routes, "_deezer_artist_releases", _mock_deezer_artist_releases)
    monkeypatch.setattr(catalog_routes, "_deezer_related_artists", _mock_deezer_related)

    body = _make_app().test_client().get("/api/catalog/artist?name=Oliver+Heldens").get_json()

    assert body["in_library"] is True
    assert body["top_tracks"][0]["title"] == "Gecko"
    assert body["top_tracks"][0]["action_state"]["in_library"] is True


def test_album_endpoint_with_deezer_id(monkeypatch):
    metadata = LibraryMetadata(version=1, tracks=[], playlists={}, settings={})
    monkeypatch.setattr(catalog_routes, "_get_api", lambda: _fake_api(metadata))

    def mock_album_profile(album_id, library_keys=None):
        return {
            "title": "Heldeep Sessions",
            "artist": "Oliver Heldens",
            "cover": "http://x/201.jpg",
            "year": 2020,
            "genre": "Electronic",
            "tracklist": [
                catalog_routes._catalog_item(
                    item_id="deezer:track:201",
                    item_type="track",
                    source="deezer",
                    title="Track One",
                    subtitle="Oliver Heldens",
                    artist="Oliver Heldens",
                    external_ids={"deezer_id": "201"},
                ),
            ],
        }

    monkeypatch.setattr(catalog_routes, "_deezer_album_profile", mock_album_profile)

    body = _make_app().test_client().get("/api/catalog/album?name=Heldeep+Sessions&deezer_id=201&artist=Oliver+Heldens").get_json()

    assert body["resolved"] is True
    assert body["title"] == "Heldeep Sessions"
    assert body["artist"] == "Oliver Heldens"
    assert body["year"] == 2020
    assert body["genre"] == "Electronic"
    assert len(body["tracklist"]) == 1
    assert body["tracklist"][0]["title"] == "Track One"


def test_album_endpoint_by_name(monkeypatch):
    metadata = LibraryMetadata(version=1, tracks=[], playlists={}, settings={})
    monkeypatch.setattr(catalog_routes, "_get_api", lambda: _fake_api(metadata))
    monkeypatch.setattr(catalog_routes, "_resolve_album_deezer_id", lambda name, artist: "201")

    def mock_album_profile(album_id, library_keys=None):
        return {
            "title": "Heldeep Sessions",
            "artist": "Oliver Heldens",
            "cover": "http://x/201.jpg",
            "year": 2020,
            "genre": "",
            "tracklist": [],
        }

    monkeypatch.setattr(catalog_routes, "_deezer_album_profile", mock_album_profile)

    body = _make_app().test_client().get("/api/catalog/album?name=Heldeep+Sessions&artist=Oliver+Heldens").get_json()

    assert body["resolved"] is True
    assert body["title"] == "Heldeep Sessions"


def test_album_endpoint_not_in_deezer(monkeypatch):
    metadata = LibraryMetadata(version=1, tracks=[_track_full("local-1", "Local Track", "Oliver Heldens", "Local Album")], playlists={}, settings={})
    monkeypatch.setattr(catalog_routes, "_get_api", lambda: _fake_api(metadata))
    monkeypatch.setattr(catalog_routes, "_resolve_album_deezer_id", lambda name, artist: None)

    body = _make_app().test_client().get("/api/catalog/album?name=Local+Album&artist=Oliver+Heldens").get_json()

    assert body["resolved"] is False
    assert body["in_library"] is True
    assert body["tracklist"] == []


# ──────────────────────────────────────────────────────────────────────────
# Regressions: Deezer release partitioning, greenlet failures, cache bounds
# ──────────────────────────────────────────────────────────────────────────


def _deezer_album_row(album_id: str, title: str, record_type: str, release_date: str = "2020-01-01"):
    """A row shaped like a real artist/<id>/albums entry.

    Deliberately has no `nb_tracks` key, because the live endpoint does not
    return one — that absence is what made the old `track_count` always 0.
    """
    return {
        "id": album_id,
        "title": title,
        "record_type": record_type,
        "release_date": release_date,
        "cover_xl": f"http://x/{album_id}.jpg",
        "explicit_lyrics": False,
    }


def test_artist_releases_partition_by_record_type(monkeypatch):
    """Deezer ignores the `type` argument on artist/<id>/albums: every value
    returns the same mixed rows. Partitioning must come from record_type, and
    the fetch must happen exactly once rather than per rail."""
    calls = []

    def fake_get(path, params=None, timeout=8):
        calls.append((path, dict(params or {})))
        return {
            "data": [
                _deezer_album_row("1", "Real Album", "album"),
                _deezer_album_row("2", "A Single", "single"),
                _deezer_album_row("3", "An EP", "ep"),
                _deezer_album_row("4", "Another Album", "album"),
            ]
        }

    monkeypatch.setattr(catalog_routes, "_deezer_get", fake_get)

    out = catalog_routes._deezer_artist_releases("27")

    assert [a["title"] for a in out["albums"]] == ["Real Album", "Another Album"]
    assert [s["title"] for s in out["singles_eps"]] == ["A Single", "An EP"]
    assert len(calls) == 1, "releases must be fetched once, not once per rail"
    assert "type" not in calls[0][1], "Deezer ignores `type`; sending it implies a filter that does not exist"


def test_artist_releases_treats_unknown_record_type_as_album(monkeypatch):
    monkeypatch.setattr(
        catalog_routes,
        "_deezer_get",
        lambda path, params=None, timeout=8: {"data": [_deezer_album_row("9", "Odd One", "compilation")]},
    )

    out = catalog_routes._deezer_artist_releases("27")

    assert [a["title"] for a in out["albums"]] == ["Odd One"]
    assert out["singles_eps"] == []


def test_artist_releases_omit_track_count(monkeypatch):
    """artist/<id>/albums carries no nb_tracks, so no track_count is emitted
    rather than a hardcoded 0 that the UI would render as a blank count."""
    monkeypatch.setattr(
        catalog_routes,
        "_deezer_get",
        lambda path, params=None, timeout=8: {"data": [_deezer_album_row("1", "Real Album", "album")]},
    )

    album = catalog_routes._deezer_artist_releases("27")["albums"][0]

    assert "track_count" not in album
    assert album["year"] == 2020
    assert album["record_type"] == "album"


def test_artist_endpoint_reports_failing_fetch_instead_of_null(monkeypatch):
    """A fetch that raises must surface in partial_failures and leave the rail
    an empty list. Reading greenlet .value swallowed the error and emitted null."""
    metadata = LibraryMetadata(version=1, tracks=[], playlists={}, settings={})
    monkeypatch.setattr(catalog_routes, "_get_api", lambda: _fake_api(metadata))
    monkeypatch.setattr(catalog_routes, "_resolve_artist_id", _mock_resolve_artist_id)
    monkeypatch.setattr(catalog_routes, "_deezer_artist_profile", _mock_deezer_artist_profile)
    monkeypatch.setattr(catalog_routes, "_deezer_artist_top_tracks", _mock_deezer_artist_top)
    monkeypatch.setattr(catalog_routes, "_deezer_related_artists", _mock_deezer_related)

    def boom(artist_id, limit=100):
        raise RuntimeError("deezer 503")

    monkeypatch.setattr(catalog_routes, "_deezer_artist_releases", boom)

    body = _make_app().test_client().get("/api/catalog/artist?name=Oliver+Heldens").get_json()

    assert body["albums"] == []
    assert body["singles_eps"] == []
    assert body["albums"] is not None and body["singles_eps"] is not None
    assert {"source": "deezer", "error": "deezer 503"} in body["partial_failures"]
    # An unrelated rail still resolves.
    assert body["top_tracks"][0]["title"] == "Gecko"


def test_gather_reports_timed_out_job(monkeypatch):
    """A greenlet still running at the deadline leaves both .value and
    .exception unset, so it must be reported from .successful()."""
    pytest.importorskip("gevent")
    import gevent

    monkeypatch.setattr(catalog_routes, "_DEEZER_FANOUT_TIMEOUT_SEC", 0.05)
    failures = []

    def slow():
        gevent.sleep(5)
        return ["never"]

    results = catalog_routes._gather((("slow", slow), ("fast", lambda: ["ok"])), failures)

    assert results.get("fast") == ["ok"]
    assert "slow" not in results
    assert failures == [{"source": "deezer", "error": "timed out"}]


def test_memo_resolve_caps_size_and_reports_hits():
    memo = Memo(ttl_sec=600, maxsize=3)
    for i in range(10):
        body, cached = catalog_routes._memo_resolve(memo, f"k{i}", lambda i=i: {"v": i})
        assert cached is False

    assert len(memo) <= 3
    assert catalog_routes._memo_resolve(memo, "k9", lambda: {"v": "recomputed"}) == ({"v": 9}, True)


def test_memo_resolve_drops_expired_entry():
    memo = Memo(ttl_sec=-1)
    catalog_routes._memo_resolve(memo, "k", lambda: {"v": 1})
    assert memo.get(catalog_routes._scoped("k")) is None


def test_cached_body_is_isolated_from_caller_mutation():
    memo = Memo(ttl_sec=600)
    first, _ = catalog_routes._memo_resolve(memo, "k", lambda: {"v": 1})
    first["v"] = "mutated"
    assert catalog_routes._memo_resolve(memo, "k", lambda: {"v": "recomputed"}) == ({"v": 1}, True)


def test_memo_resolve_collapses_concurrent_identical_searches():
    """One fan-out, not N. A cache only helps *after* the first call returns."""
    memo = Memo(ttl_sec=600)
    calls = []
    release = threading.Event()

    def compute():
        calls.append(1)
        release.wait(5)
        return {"v": "once"}

    results: list[dict] = []
    threads = [
        threading.Thread(target=lambda: results.append(catalog_routes._memo_resolve(memo, "k", compute)[0]))
        for _ in range(5)
    ]
    for thread in threads:
        thread.start()
    time.sleep(0.05)
    release.set()
    for thread in threads:
        thread.join(5)

    assert len(calls) == 1
    assert results == [{"v": "once"}] * 5


def test_resolve_artist_id_returns_other_exact_matches_as_candidates(monkeypatch):
    monkeypatch.setattr(
        catalog_routes,
        "_deezer_artist_search",
        lambda name, limit=10: [
            {"deezer_id": "1", "name": "Nirvana", "picture": "", "nb_fans": 10, "nb_album": 1},
            {"deezer_id": "2", "name": "Nirvana", "picture": "", "nb_fans": 900, "nb_album": 2},
            {"deezer_id": "3", "name": "Nirvana UK", "picture": "", "nb_fans": 5, "nb_album": 1},
        ],
    )

    resolved, candidates = catalog_routes._resolve_artist_id("Nirvana")

    assert resolved == "2", "most-followed exact match wins"
    assert [c["deezer_id"] for c in candidates] == ["1"]


# ── Owned-track key lookups ────────────────────────────────────────────────
#
# These used to walk the whole library per call, and a single /api/catalog/artist
# call made three of them. They are answered from one indexed pass now, so these
# tests check the index agrees with the scan it replaced.


def _naive_artist_keys(tracks, name):
    norm, key = catalog_routes._norm, catalog_routes._key
    name_key = norm(name)
    keys = set()
    for track in tracks:
        artist = track.artist or track.album_artist or ""
        if name_key and norm(artist) != name_key:
            continue
        keys.add(key(track.title or "", artist))
    return keys


def _naive_album_keys(tracks, album_name, artist):
    norm, key = catalog_routes._norm, catalog_routes._key
    album_key, artist_key = norm(album_name), norm(artist)
    keys = set()
    for track in tracks:
        t_artist = track.artist or track.album_artist or ""
        if album_key and norm(track.album or "") != album_key:
            continue
        if artist_key and norm(t_artist) != artist_key:
            continue
        keys.add(key(track.title or "", t_artist))
    return keys


@pytest.fixture()
def indexed_library(monkeypatch):
    tracks = [
        _track_full("t1", "Alpha", "Boards of Canada", album="Geogaddi"),
        _track_full("t2", "Beta", "Boards of Canada", album="Geogaddi"),
        _track_full("t3", "Gamma", "Boards of Canada", album="Tomorrow"),
        _track_full("t4", "Delta", "Aphex Twin", album="Geogaddi"),
        _track_full("t5", "Epsilon", "aphex twin", album="Drukqs"),
    ]
    monkeypatch.setattr(catalog_routes, "_load_library_tracks", lambda: tracks)
    return tracks


@pytest.mark.parametrize(
    "artist",
    ["Boards of Canada", "boards of canada", "Aphex Twin", "Nobody", ""],
)
def test_artist_keys_match_a_full_scan(indexed_library, artist):
    from shared import request_scope

    with request_scope.request_scope():
        assert catalog_routes._library_artist_keys(artist) == _naive_artist_keys(
            indexed_library, artist
        )


@pytest.mark.parametrize(
    ("album", "artist"),
    [
        ("Geogaddi", "Boards of Canada"),
        ("Geogaddi", ""),
        ("", "Aphex Twin"),
        ("", ""),
        ("Unknown", "Boards of Canada"),
    ],
)
def test_album_keys_match_a_full_scan(indexed_library, album, artist):
    from shared import request_scope

    with request_scope.request_scope():
        assert catalog_routes._library_album_keys(album, artist) == _naive_album_keys(
            indexed_library, album, artist
        )


def test_library_is_loaded_once_per_request(monkeypatch):
    from shared import request_scope

    calls = {"n": 0}

    def counting_load():
        calls["n"] += 1
        return []

    monkeypatch.setattr(catalog_routes, "_load_library_tracks", counting_load)

    with request_scope.request_scope():
        catalog_routes._library_artist_keys("A")
        catalog_routes._library_album_keys("B", "C")
        catalog_routes._library_tracks()

    assert calls["n"] == 1
