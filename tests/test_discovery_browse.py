from collections import Counter
import datetime
from types import SimpleNamespace

from shared.discovery_browse import build_browse_sections
from shared.providers import deezer


def artist(aid, name=None):
    return {"id": aid, "name": name or f"Artist {aid}", "picture_big": f"https://image.test/{aid}"}


def test_personalized_entities_are_interleaved_unique_and_navigable(monkeypatch):
    def get(path, params=None, **kwargs):
        if path == "search/artist":
            return {"data": [artist(int(params["q"].split()[-1]))]}
        if path.endswith("/related"):
            aid = int(path.split('/')[1])
            return {"data": [artist(10 + aid), artist(99), artist(aid), artist(20 + aid)]}
        if path.endswith("/albums"):
            aid = int(path.split('/')[1])
            return {"data": [
                {"id": aid * 100 + i, "title": f"Album {i}", "record_type": "single" if i == 0 else ("compile" if i == 4 else "album"), "release_date": f"2026-0{i + 1}-01"}
                for i in range(5)
            ]}
        raise AssertionError(path)
    monkeypatch.setattr(deezer, 'get', get)
    body = build_browse_sections(['Artist 1', 'Artist 2'])
    artists, albums = body['browse_sections']
    assert [r['title'] for r in artists['items']][:3] == ['Artist 11', 'Artist 12', 'Artist 99']
    assert len({r['id'] for r in artists['items']}) == len(artists['items'])
    assert artists['items'][0]['reason_artist'] == 'Artist 1'
    assert not artists['popular']
    assert len(albums['items']) == 10
    counts = Counter(r['external_ids']['deezer_artist_id'] for r in albums['items'])
    assert max(counts.values()) == 2
    assert all(r['external_ids']['deezer_album_id'] for r in albums['items'])
    assert all(r['reason_artist'] in {'Artist 1', 'Artist 2'} for r in albums['items'])
    assert any(r['title'] == 'Album 0' and r['record_type'] == 'single' and r['release_date'] == '2026-01-01' for r in albums['items'])
    assert not any(r['title'] == 'Album 4' for r in albums['items'])
    assert not body['browse_error']


def test_albums_prioritize_related_artists_and_skip_owned_albums(monkeypatch):
    from shared.text_utils import identity_key

    def get(path, params=None, **kwargs):
        if path == "search/artist":
            return {"data": [artist(1, "Seed Band")]}
        if path == "artist/1/related":
            return {"data": [artist(2, "Related Band")]}
        if path == "artist/2/albums":
            return {"data": [
                {"id": 201, "title": "Already Owned LP", "record_type": "album", "release_date": "2024-01-01"},
                {"id": 202, "title": "Unowned Discovery LP", "record_type": "album", "release_date": "2024-02-01"},
            ]}
        if path == "artist/1/albums":
            return {"data": [
                {"id": 101, "title": "Seed Catalog LP", "record_type": "album", "release_date": "2022-01-01"},
            ]}
        raise AssertionError(path)

    monkeypatch.setattr(deezer, "get", get)
    body = build_browse_sections(
        ["Seed Band"],
        owned_album_keys={identity_key("Already Owned LP", "Related Band")},
        today=datetime.date(2026, 11, 22),
    )
    sections_by_id = {sec["id"]: sec for sec in body["browse_sections"]}
    albums = sections_by_id["albums"]["items"]
    assert [item["title"] for item in albums] == ["Unowned Discovery LP", "Seed Catalog LP"]
    assert albums[0]["reason_artist"] == "Seed Band"
    assert albums[1]["reason_artist"] == ""


def test_diacritic_folded_artist_resolution_prefers_highest_fan_count(monkeypatch):
    def get(path, params=None, **kwargs):
        if path == "search/artist":
            return {"data": [
                {"id": 10, "name": "Blue Oyster Cult", "nb_fan": 12, "picture_big": "https://image.test/10"},
                {"id": 20, "name": "Blue Öyster Cult", "nb_fan": 500000, "picture_big": "https://image.test/20"},
            ]}
        if path == "artist/20/related":
            return {"data": [artist(21, "Thin Lizzy")]}
        if path == "artist/20/albums":
            return {"data": [{"id": 300, "title": "Older Album", "record_type": "album", "release_date": "2020-10-01"}]}
        if path == "artist/21/albums":
            return {"data": [{"id": 301, "title": "Release EP", "record_type": "ep", "release_date": "2024-10-01"}]}
        raise AssertionError(path)

    monkeypatch.setattr(deezer, "get", get)
    body = build_browse_sections(["Blue Oyster Cult"], today=datetime.date(2026, 11, 22))
    artists, albums = body["browse_sections"]
    assert artists["items"][0]["title"] == "Thin Lizzy"
    assert artists["items"][0]["reason_artist"] == "Blue Oyster Cult"
    assert any(item["record_type"] == "ep" and item["release_date"] == "2024-10-01" for item in albums["items"])


def test_halo_seed_ignores_hal_macron_homonym_and_keeps_memo_keys_distinct(monkeypatch):
    asked_limits = []

    def get(path, params=None, **kwargs):
        if path == "search/artist":
            asked_limits.append(params.get("limit"))
            return {"data": [
                {"id": 89290162, "name": "Halo", "nb_fan": 2, "picture_big": "https://image.test/1"},
                {"id": 139303402, "name": "Halo", "nb_fan": 24, "picture_big": "https://image.test/2"},
                {"id": 422708332, "name": "HALŌ", "nb_fan": 39, "picture_big": "https://image.test/3"},
                {"id": 89289852, "name": "Halo", "nb_fan": 13, "picture_big": "https://image.test/4"},
                {"id": 89289952, "name": "Halo", "nb_fan": 9, "picture_big": "https://image.test/5"},
                {"id": 111851312, "name": "Halo", "nb_fan": 2, "picture_big": "https://image.test/6"},
                {"id": 124279882, "name": "Halo", "nb_fan": 3, "picture_big": "https://image.test/7"},
                {"id": 89289972, "name": "Halo", "nb_fan": 17, "picture_big": "https://image.test/8"},
                {"id": 217605285, "name": "Halo", "nb_fan": 2170, "picture_big": "https://image.test/2170"},
            ]}
        if path == "artist/217605285/related":
            return {"data": [artist(15902, "Jesper Kyd")]}
        if path == "artist/422708332/related":
            return {"data": [artist(1032901, "Matisse & Sadko")]}
        if path == "artist/217605285/albums":
            return {"data": [{"id": 6629, "title": "Halo Season 1 Original Soundtrack", "record_type": "album", "release_date": "2024-11-12"}]}
        if path == "artist/15902/albums":
            return {"data": []}
        if path == "artist/422708332/albums":
            return {"data": [{"id": 1134, "title": "Now Until Forever", "record_type": "single", "release_date": "2026-11-13"}]}
        if path == "artist/1032901/albums":
            return {"data": []}
        if path == "album/1134":
            return {"id": 1134, "title": "Now Until Forever", "contributors": [{"id": 422708332, "name": "HALŌ", "role": "Main"}]}
        raise AssertionError(path)

    monkeypatch.setattr(deezer, "get", get)

    # Resolving "Halo" alone picks the 2170-fan OST artist, never HALŌ's 2026 single.
    body_halo = build_browse_sections(["Halo"], today=datetime.date(2026, 11, 24))
    assert asked_limits == [25]
    sections_halo = {sec["id"]: sec["items"] for sec in body_halo["browse_sections"]}
    assert "new_releases" not in sections_halo
    assert [item["title"] for item in sections_halo["artists"]] == ["Jesper Kyd"]

    # Resolving both "Halo" and "HALŌ" in the same call must not collide in the per-call memo.
    body_both = build_browse_sections(["Halo", "HALŌ"], today=datetime.date(2026, 11, 24))
    sections_both = {sec["id"]: sec["items"] for sec in body_both["browse_sections"]}
    assert [item["title"] for item in sections_both["artists"]] == ["Jesper Kyd", "Matisse & Sadko"]
    assert [item["title"] for item in sections_both["new_releases"]] == ["Now Until Forever"]


def test_new_releases_sorted_newest_first_with_badge_window_and_dedup(monkeypatch):
    ref_today = datetime.date(2026, 11, 22)

    def get(path, params=None, **kwargs):
        if path == "search/artist":
            name = params["q"]
            aid = 100 if name == "Artist One" else 200
            return {"data": [artist(aid, name)]}
        if path == "artist/100/related":
            return {"data": [artist(101, "Related One")]}
        if path == "artist/200/related":
            return {"data": [artist(201, "Related Two")]}
        if path == "artist/100/albums":
            return {"data": [
                {"id": 1001, "title": "Brand New Single", "record_type": "single", "release_date": "2026-11-17"},
                {"id": 1002, "title": "Thirty Day EP", "record_type": "ep", "release_date": "2026-10-23"},
                {"id": 1003, "title": "Third Same Artist", "record_type": "album", "release_date": "2026-10-01"},
                {"id": 1004, "title": "Archive LP", "record_type": "album", "release_date": "2025-01-01"},
                {"id": 1005, "title": "Future LP", "record_type": "album", "release_date": "2026-11-25"},
            ]}
        if path == "artist/200/albums":
            return {"data": [
                {"id": 2001, "title": "Thirty One Days", "record_type": "album", "release_date": "2026-10-22"},
                {"id": 2002, "title": "Edge 180", "record_type": "single", "release_date": "2026-05-26"},
                {"id": 2003, "title": "Too Old 181", "record_type": "album", "release_date": "2026-05-25"},
                {"id": 2004, "title": "Bad Date", "record_type": "album", "release_date": "unknown"},
            ]}
        if path in ("artist/101/albums", "artist/201/albums"):
            return {"data": []}
        if path.startswith("album/"):
            return {"id": int(path.split("/")[1])}
        raise AssertionError(path)

    monkeypatch.setattr(deezer, "get", get)
    body = build_browse_sections(
        ["Artist One", "Artist Two"],
        limit=10,
        today=ref_today,
    )
    sections_by_id = {sec["id"]: sec for sec in body["browse_sections"]}
    new_rel = sections_by_id["new_releases"]["items"]
    assert [item["title"] for item in new_rel] == [
        "Brand New Single",
        "Thirty Day EP",
        "Thirty One Days",
        "Edge 180",
    ]
    assert [item["is_new"] for item in new_rel] == [True, True, False, False]
    assert all(item["reason_artist"] == "" for item in new_rel)

    # Albums section must not duplicate releases already surfaced in new_releases.
    new_ids = {item["external_ids"]["deezer_album_id"] for item in new_rel}
    album_ids = {item["external_ids"]["deezer_album_id"] for item in sections_by_id["albums"]["items"]}
    assert new_ids.isdisjoint(album_ids)
    assert "1004" in album_ids
    assert "1003" in album_ids


def test_new_releases_reuse_saved_deezer_id_without_artist_search(monkeypatch):
    calls = []

    def get(path, params=None, **kwargs):
        calls.append(path)
        if path == "search/artist":
            return {"data": [artist(1, params["q"])]}
        if path == "artist/1/related":
            return {"data": []}
        if path == "artist/1/albums":
            return {"data": []}
        if path == "artist/555/albums":
            return {"data": [
                {"id": 9001, "title": "Saved Band New EP", "record_type": "ep", "release_date": "2026-11-18"},
            ]}
        if path == "album/9001":
            return {
                "id": 9001,
                "title": "Saved Band New EP",
                "artist": {"id": 555, "name": "Saved Band"},
                "contributors": [{"id": 555, "name": "Saved Band", "role": "Main"}],
            }
        raise AssertionError(path)

    monkeypatch.setattr(deezer, "get", get)
    body = build_browse_sections(
        ["Alpha"],
        release_seeds=[{"name": "Saved Band", "deezer_id": "555"}],
        today=datetime.date(2026, 11, 22),
    )
    assert body["browse_sections"][0]["id"] == "new_releases"
    assert body["browse_sections"][0]["items"][0]["title"] == "Saved Band New EP"
    assert body["browse_sections"][0]["items"][0]["artist"] == "Saved Band"
    assert calls.count("search/artist") == 1
    assert "artist/555/albums" in calls


def test_new_releases_credits_multi_artist_albums_and_falls_back_on_error(monkeypatch):
    ref_today = datetime.date(2026, 11, 22)

    def get(path, params=None, **kwargs):
        if path == "artist/1536/albums":
            return {"data": [
                {"id": 1126150202, "title": "Midnight Jazz Confidential", "record_type": "album", "release_date": "2026-11-20"},
                {"id": 1105296032, "title": "Horror Cinema Club", "record_type": "album", "release_date": "2026-10-23"},
                {"id": 1100000001, "title": "Third Release Capped", "record_type": "album", "release_date": "2026-10-01"},
            ]}
        if path == "artist/777/albums":
            return {"data": [
                {"id": 7771, "title": "Solo Work", "record_type": "album", "release_date": "2026-11-10"},
            ]}
        if path == "album/1126150202":
            return {
                "id": 1126150202,
                "title": "Midnight Jazz Confidential",
                "artist": {"id": 2738, "name": "Piero Piccioni"},
                "contributors": [
                    {"id": 2738, "name": "Piero Piccioni", "role": "Main"},
                    {"id": 1536, "name": "Ennio Morricone", "role": "Main"},
                    {"id": 1536, "name": "Ennio Morricone", "role": "Main"},
                    {"id": 5741, "name": "Nino Rota", "role": "Main"},
                    {"id": 134189, "name": "Philippe Sarde", "role": "Main"},
                    {"id": 8888, "name": "Remaster Engineer", "role": "AssociatedPerformer"},
                ],
            }
        if path == "album/1105296032":
            raise TimeoutError("deezer album detail timeout")
        if path == "album/7771":
            return {
                "id": 7771,
                "title": "Solo Work",
                "artist": {"id": 777, "name": "Solo Composer"},
                "contributors": [{"id": 777, "name": "Solo Composer", "role": "Main"}],
            }
        raise AssertionError(path)

    monkeypatch.setattr(deezer, "get", get)
    body = build_browse_sections(
        [],
        release_seeds=[
            {"name": "Ennio Morricone", "deezer_id": "1536"},
            {"name": "Solo Composer", "deezer_id": "777"},
        ],
        today=ref_today,
    )
    assert not body["browse_error"]
    sections_by_id = {sec["id"]: sec for sec in body["browse_sections"]}
    items = sections_by_id["new_releases"]["items"]
    assert [item["title"] for item in items] == [
        "Midnight Jazz Confidential",
        "Solo Work",
        "Horror Cinema Club",
    ]
    assert items[0]["artist"] == "Piero Piccioni, Ennio Morricone, Nino Rota, Philippe Sarde"
    assert items[0]["subtitle"] == "Piero Piccioni, Ennio Morricone, Nino Rota, Philippe Sarde"
    assert items[0]["external_ids"]["deezer_artist_id"] == "1536"
    # Single-artist album preserves owner_name.
    assert items[1]["artist"] == "Solo Composer"
    assert items[1]["subtitle"] == "Solo Composer"
    # Failed album detail lookup preserves owner_name without failing the feed.
    assert items[2]["artist"] == "Ennio Morricone"
    assert items[2]["subtitle"] == "Ennio Morricone"


def test_cold_start_uses_popular_entities_without_personalized_reasons(monkeypatch):
    def get(path, params=None, **kwargs):
        if path.endswith('artists'):
            return {'data': [artist(1), artist(1), {'name': 'Invalid'}]}
        return {'data': [{'id': i, 'title': f'Album {i}', 'artist': artist(i % 3 + 1), 'release_date': '2026-11-20'} for i in range(1, 12)]}
    monkeypatch.setattr(deezer, 'get', get)
    body = build_browse_sections([])
    assert [s['id'] for s in body['browse_sections']] == ['artists', 'albums']
    assert all(s['popular'] for s in body['browse_sections'])
    assert len(body['browse_sections'][0]['items']) == 1
    assert len(body['browse_sections'][1]['items']) == 6
    assert all(not i['reason_artist'] for s in body['browse_sections'] for i in s['items'])


def test_partial_provider_failure_keeps_other_section(monkeypatch):
    def get(path, params=None, **kwargs):
        if path.endswith('artists'):
            raise TimeoutError()
        return {'data': [{'id': 10, 'title': 'Still available', 'artist': artist(1)}]}
    monkeypatch.setattr(deezer, 'get', get)
    body = build_browse_sections([])
    assert body['browse_error']
    assert [s['id'] for s in body['browse_sections']] == ['albums']


def test_does_not_attribute_approximate_artist_match_to_listener(monkeypatch):
    calls = []
    def get(path, params=None, **kwargs):
        calls.append(path)
        return {'data': [artist(1, 'Different Artist')]}
    monkeypatch.setattr(deezer, 'get', get)
    assert build_browse_sections(['Wanted Artist'])['browse_sections'] == []
    assert calls == ['search/artist']


def test_seed_selection_uses_listening_without_library_and_respects_disabled_learning(monkeypatch):
    from shared.api.routes import discovery_feed as route
    from shared.discovery_intelligence import emit_discovery_event, save_discovery_settings
    metadata = SimpleNamespace(tracks=[], playlists={})
    emit_discovery_event('music_played_30s', {'title': 'Song', 'artist': 'Listened Artist'})
    assert route._top_taste_artists(metadata, []) == ['Listened Artist']
    save_discovery_settings({'learning_enabled': False})
    assert route._top_taste_artists(metadata, []) == []


def test_feed_cache_reports_inflight_and_keeps_accounts_separate(monkeypatch):
    from flask import Flask
    from shared.api.routes import discovery_feed as route
    from shared.user_context import user_context
    import time

    monkeypatch.setattr(route, '_DISCOVERY_FEED_CACHE', {
        'discovery-feed-v4:alice:10': (time.time() + 180, time.time() + 3600, {'browse_sections': [{'id': 'artists', 'items': [{'title': 'Alice artist'}]}]}),
        'discovery-feed-v4:bob:10': (time.time() + 180, time.time() + 3600, {'browse_sections': [{'id': 'artists', 'items': [{'title': 'Bob artist'}]}]}),
    })
    monkeypatch.setattr(route, '_DISCOVERY_FEED_INFLIGHT', {'discovery-feed-v4:alice:10'})
    app = Flask(__name__)
    for user_id, expected_busy in [('alice', True), ('bob', False)]:
        with app.test_request_context('/api/discovery/music/feed?limit=10'), user_context(user_id):
            body = route.discovery_music_feed.__wrapped__().get_json()
        assert body['revalidating'] is expected_busy
        assert body['browse_sections'][0]['items'][0]['title'] == f'{user_id.title()} artist'


def test_failed_enrichment_preserves_cached_entities(monkeypatch):
    from shared.api.routes import discovery_feed as route
    key = 'discovery-feed-v4:testuser:10'
    old_new = {'id': 'new_releases', 'items': [{'title': 'Fresh EP'}]}
    old = {'id': 'artists', 'items': [{'title': 'Existing'}]}
    monkeypatch.setattr(route, '_DISCOVERY_FEED_CACHE', {key: (0, 9999999999, {'browse_sections': [old_new, old]})})
    monkeypatch.setattr(route, '_DISCOVERY_FEED_INFLIGHT', {key})
    monkeypatch.setattr(route, '_build_discovery_feed_body', lambda *args, **kwargs: {'browse_error': True, 'browse_sections': []})
    route._refresh_discovery_feed_cache(key, 'testuser', 10)
    assert route._DISCOVERY_FEED_CACHE[key][2]['browse_sections'] == [old_new, old]
    assert key not in route._DISCOVERY_FEED_INFLIGHT


def test_less_from_artist_demotes_browse_sections_and_related_rows(tmp_path, monkeypatch):
    from shared.api.routes import discovery_feed as route
    from shared.discovery_intelligence import record_less_from_artist
    from shared.runtime import RuntimeConfig, configure_runtime, reset_runtime

    reset_runtime()
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
    try:
        record_less_from_artist({"artist": "Disliked Band", "deezer_artist_id": "11"})

        def get(path, params=None, **kwargs):
            if path == "search/artist":
                return {"data": [artist(1, "Seed Band")]}
            if path == "artist/1/related":
                return {"data": [artist(11, "Disliked Band"), artist(12, "Good Band")]}
            if path == "artist/11/albums":
                return {"data": [{"id": 1101, "title": "Disliked New", "record_type": "album", "release_date": "2026-11-20"}]}
            if path == "artist/12/albums":
                return {"data": [{"id": 1201, "title": "Good New", "record_type": "album", "release_date": "2026-11-10"}]}
            if path == "artist/1/albums":
                return {"data": []}
            if path == "artist/11/top":
                return {"data": [{"id": 911, "title": "Disliked Track", "artist": artist(11, "Disliked Band")}]}
            if path == "artist/12/top":
                return {"data": [{"id": 912, "title": "Good Track", "artist": artist(12, "Good Band")}]}
            raise AssertionError(path)

        monkeypatch.setattr(deezer, "get", get)
        body = build_browse_sections(
            ["Seed Band"],
            limit=10,
            release_seeds=[
                {"name": "Disliked Band", "deezer_id": "11"},
                {"name": "Good Band", "deezer_id": "12"},
            ],
            today=datetime.date(2026, 11, 22),
        )
        sections = {sec["id"]: sec["items"] for sec in body["browse_sections"]}
        assert [item["title"] for item in sections["artists"]] == ["Good Band", "Disliked Band"]
        assert [item["title"] for item in sections["new_releases"]] == ["Good New", "Disliked New"]

        related_rows = route._deezer_related_artist_rows("Seed Band", limit=4)
        assert [row["title"] for row in related_rows] == ["Good Track", "Disliked Track"]
    finally:
        reset_runtime()


def test_background_feed_refresh_builds_signal_index_once_per_refresh(tmp_path, monkeypatch):
    from shared import discovery_intelligence as di
    from shared.api.routes import discovery_feed as route
    from shared.models import LibraryMetadata, Track
    from shared.runtime import RuntimeConfig, configure_runtime, reset_runtime

    reset_runtime()
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
    try:
        tracks = [
            Track(
                id=f"t{i}",
                title=f"Song {i}",
                artist=f"Seed {i}",
                album="Album",
                duration=180,
                file_hash=f"h-{i}",
                original_filename=f"t{i}.mp3",
                file_size=1000,
                bitrate=320,
                format="mp3",
            )
            for i in range(1, 4)
        ]
        lib = SimpleNamespace(
            metadata=LibraryMetadata(version=1, tracks=tracks, playlists={}, settings={}),
            refresh_if_stale=lambda: None,
        )
        monkeypatch.setattr(
            route,
            "_get_api",
            lambda: {
                "get_library": lambda: lib,
                "favourite_library_ids": lambda: ["t1"],
                "emit_to_user": lambda *a, **kw: None,
            },
        )
        monkeypatch.setattr(route, "_DISCOVERY_FEED_CACHE", {})
        monkeypatch.setattr(route, "_DISCOVERY_FEED_INFLIGHT", {"k-once"})

        def get(path, params=None, **kwargs):
            if path == "search/artist":
                idx = int(params["q"].split()[-1])
                return {"data": [artist(idx, params["q"])]}
            if path.endswith("/related"):
                aid = int(path.split("/")[1])
                return {"data": [artist(10 + aid, f"Rel {aid}A"), artist(20 + aid, f"Rel {aid}B")]}
            if path.endswith("/top"):
                aid = int(path.split("/")[1])
                return {"data": [{"id": aid * 100, "title": f"Hit {aid}", "artist": artist(aid, f"Rel {aid}")}]}
            if path.endswith("/albums"):
                aid = int(path.split("/")[1])
                return {"data": [{"id": aid * 1000, "title": f"LP {aid}", "record_type": "album", "release_date": "2026-11-15"}]}
            raise AssertionError(path)

        monkeypatch.setattr(deezer, "get", get)

        builds = 0
        original_build = di._build_signal_index

        def counting_build():
            nonlocal builds
            builds += 1
            return original_build()

        monkeypatch.setattr(di, "_build_signal_index", counting_build)
        route._refresh_discovery_feed_cache("k-once", "alice", 10)
        assert builds == 1
    finally:
        reset_runtime()
