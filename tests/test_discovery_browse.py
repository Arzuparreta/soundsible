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
                {"id": aid * 100 + i, "title": f"Album {i}", "record_type": "single" if i == 0 else ("compile" if i == 4 else "album"), "release_date": f"2026-0{5 - i}-01"}
                for i in range(5)
            ]}
        raise AssertionError(path)
    monkeypatch.setattr(deezer, 'get', get)
    body = build_browse_sections(['Artist 1', 'Artist 2'], today=datetime.date(2026, 11, 24))
    artists, albums = body['browse_sections']
    # Consensus boosts Artist 99 (related to both seeds) ahead of single-seed neighbors.
    assert artists['items'][0]['title'] == 'Artist 99'
    assert {r['title'] for r in artists['items'][:3]} == {'Artist 99', 'Artist 11', 'Artist 12'}
    assert len({r['id'] for r in artists['items']}) == len(artists['items'])
    assert artists['items'][0]['reason_artist'] in {'Artist 1', 'Artist 2'}
    assert not artists['popular']
    assert len(albums['items']) == 10
    counts = Counter(r['external_ids']['deezer_artist_id'] for r in albums['items'])
    assert max(counts.values()) == 2
    assert all(r['external_ids']['deezer_album_id'] for r in albums['items'])
    assert all(r['reason_artist'] in {'Artist 1', 'Artist 2'} for r in albums['items'])
    assert any(r['title'] == 'Album 0' and r['record_type'] == 'single' and r['release_date'] == '2026-05-01' for r in albums['items'])
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
    assert "release_radar" not in sections_halo
    assert [item["title"] for item in sections_halo["artists"]] == ["Jesper Kyd"]

    # Resolving both "Halo" and "HALŌ" keeps memo keys distinct; seed releases live on Home.
    body_both = build_browse_sections(["Halo", "HALŌ"], today=datetime.date(2026, 11, 24))
    sections_both = {sec["id"]: sec["items"] for sec in body_both["browse_sections"]}
    assert [item["title"] for item in sections_both["artists"]] == ["Jesper Kyd", "Matisse & Sadko"]
    assert "release_radar" not in sections_both

    # Home New Releases surfaces HALŌ's single strictly when HALŌ is in the taste profile.
    from shared.api.routes import discovery_feed as route
    from shared.models import LibraryMetadata, Track

    lib = SimpleNamespace(
        metadata=LibraryMetadata(
            version=1,
            tracks=[Track(id="h1", title="Midnight", artist="HALŌ", album="Single", duration=180, file_hash="h1", original_filename="h1.mp3", file_size=100, bitrate=320, format="mp3")],
            playlists={},
            settings={},
        ),
        refresh_if_stale=lambda: None,
    )
    monkeypatch.setattr(
        route,
        "_get_api",
        lambda: {"get_library": lambda: lib, "favourite_library_ids": lambda: ["h1"], "emit_to_user": lambda *a, **k: None},
    )
    home = route.build_home_new_releases(sync_inline=True, today=datetime.date(2026, 11, 24))
    assert [item["title"] for item in home["items"]] == ["Now Until Forever"]


def test_resolve_seed_artist_skips_malformed_ids_and_combining_only_input(monkeypatch):
    calls = []

    def get(path, params=None, **kwargs):
        calls.append((path, params))
        if path == "search/artist":
            return {"data": [
                {"id": "bad-id", "name": "Valid Band", "nb_fan": 999999},
                {"id": 42, "name": "Valid Band", "nb_fan": 10, "picture_big": "https://image.test/42"},
            ]}
        if path == "artist/42/related":
            return {"data": [artist(43, "Related Valid")]}
        if path == "artist/42/albums":
            return {"data": []}
        if path == "artist/43/albums":
            return {"data": []}
        raise AssertionError(path)

    monkeypatch.setattr(deezer, "get", get)
    assert build_browse_sections(["\u0301\u0304"], today=datetime.date(2026, 11, 24))["browse_sections"] == []
    assert calls == []

    body = build_browse_sections(["Valid Band"], today=datetime.date(2026, 11, 24))
    assert body["browse_sections"][0]["items"][0]["title"] == "Related Valid"


def test_release_radar_sorted_newest_first_45d_window_badge_and_dedup(monkeypatch):
    from shared.api.routes.catalog import _deezer_artist_releases

    ref_today = datetime.date(2026, 11, 22)
    album_calls = []

    def get(path, params=None, **kwargs):
        if path == "search/artist":
            name = params["q"]
            aid = 100 if name == "Seed One" else 200
            return {"data": [artist(aid, name)]}
        if path == "artist/100/related":
            return {"data": [
                artist(101, "Related One"),
                artist(102, "Related Three"),
                artist(103, "Related Four"),
            ]}
        if path == "artist/200/related":
            return {"data": [artist(201, "Related Two")]}
        if path == "artist/101/albums":
            album_calls.append(path)
            return {"data": [
                {"id": 1001, "title": "Brand New Single", "record_type": "single", "release_date": "2026-11-17"},
                {"id": 1002, "title": "Thirty Day EP", "record_type": "ep", "release_date": "2026-10-23"},
                {"id": 1003, "title": "Third Same Artist", "record_type": "album", "release_date": "2026-10-15"},
                {"id": 1004, "title": "Archive LP", "record_type": "album", "release_date": "2025-01-01"},
                {"id": 1005, "title": "Future LP", "record_type": "album", "release_date": "2026-11-25"},
            ]}
        if path == "artist/102/albums":
            album_calls.append(path)
            return {"data": [{"id": 1021, "title": "Recent Peer Single", "record_type": "single", "release_date": "2026-11-18"}]}
        if path == "artist/103/albums":
            album_calls.append(path)
            return {"data": [{"id": 1031, "title": "Recent Peer LP", "record_type": "album", "release_date": "2026-11-12"}]}
        if path == "artist/201/albums":
            album_calls.append(path)
            return {"data": [
                {"id": 2001, "title": "Forty Five Days", "record_type": "album", "release_date": "2026-10-08"},
                {"id": 2002, "title": "Too Old 46", "record_type": "single", "release_date": "2026-10-07"},
                {"id": 2004, "title": "Bad Date", "record_type": "album", "release_date": "unknown"},
            ]}
        if path in ("artist/100/albums", "artist/200/albums"):
            return {"data": []}
        if path.startswith("album/"):
            return {"id": int(path.split("/")[1])}
        raise AssertionError(path)

    monkeypatch.setattr(deezer, "get", get)
    assert _deezer_artist_releases("101")["singles_eps"][0]["title"] == "Brand New Single"
    assert album_calls == ["artist/101/albums"]
    body = build_browse_sections(["Seed One", "Seed Two"], limit=10, today=ref_today)
    sections_by_id = {sec["id"]: sec for sec in body["browse_sections"]}
    radar = sections_by_id["release_radar"]["items"]
    assert [item["title"] for item in radar] == [
        "Recent Peer Single",
        "Recent Peer LP",
        "Thirty Day EP",
        "Forty Five Days",
    ]
    assert [item["is_new"] for item in radar] == [True, True, True, False]
    assert radar[0]["reason_artist"] == "Seed One"
    assert radar[2]["reason_artist"] == "Seed One"
    assert radar[3]["reason_artist"] == "Seed Two"

    # Albums for you reuses cached releases without duplicating items already in Release Radar.
    radar_ids = {item["external_ids"]["deezer_album_id"] for item in radar}
    album_ids = {item["external_ids"]["deezer_album_id"] for item in sections_by_id["albums"]["items"]}
    assert radar_ids.isdisjoint(album_ids)
    assert "1001" in album_ids
    assert "1005" not in radar_ids
    assert "2002" in album_ids

    assert _deezer_artist_releases("201")["albums"][0]["title"] == "Forty Five Days"
    assert sorted(album_calls) == ["artist/101/albums", "artist/102/albums", "artist/103/albums", "artist/201/albums"]
    assert len(album_calls) == 4

    without_profile_artist = build_browse_sections(
        ["Seed One", "Seed Two"], profile_artist_ids={"201"}, today=ref_today,
    )
    radar_without_profile = next(s["items"] for s in without_profile_artist["browse_sections"] if s["id"] == "release_radar")
    assert all(item["external_ids"]["deezer_artist_id"] != "201" for item in radar_without_profile)

    # Second call reads persisted artist_releases_cache with zero extra album fetches.
    prev_calls = len(album_calls)
    cached_body = build_browse_sections(["Seed One", "Seed Two"], limit=10, today=ref_today)
    assert len(album_calls) == prev_calls
    cached_radar = {sec["id"]: sec["items"] for sec in cached_body["browse_sections"]}["release_radar"]
    assert [item["title"] for item in cached_radar] == [item["title"] for item in radar]


def test_release_radar_hydrates_past_first_batch_when_catalogues_are_cold(monkeypatch):
    from shared import discovery_browse
    from shared.database import instance_db

    db = instance_db()
    now = int(datetime.datetime.now(datetime.timezone.utc).timestamp())
    db.upsert_graph_nodes([
        {"deezer_artist_id": "1", "name": "Seed", "literal_key": "seed",
         "folded_key": "seed", "related_synced_at": now},
        *[
            {"deezer_artist_id": str(aid), "name": f"Peer {aid}",
             "literal_key": f"peer {aid}", "folded_key": f"peer {aid}"}
            for aid in range(10, 30)
        ],
    ])
    db.replace_similarity_edges("1", "deezer", [
        (str(aid), aid - 10, 1 / (aid - 9)) for aid in range(10, 30)
    ], now)
    calls = []
    sync_calls = []
    orig_sync = discovery_browse.sync_artist_releases

    def counting_sync(*args, **kwargs):
        sync_calls.append(kwargs.get("max_sync"))
        return orig_sync(*args, **kwargs)

    def get(path, params=None, **kwargs):
        if path == "album/2400":
            return {"id": 2400}
        assert path.endswith("/albums"), path
        aid = int(path.split("/")[1])
        calls.append(aid)
        return {"data": [{
            "id": aid * 100,
            "title": "New release" if aid == 24 else f"Back catalogue {aid}",
            "record_type": "album",
            "release_date": "2026-11-20" if aid == 24 else "2025-01-01",
        }]}

    monkeypatch.setattr(discovery_browse, "sync_artist_releases", counting_sync)
    monkeypatch.setattr(deezer, "get", get)
    body = build_browse_sections(["Seed"], today=datetime.date(2026, 11, 26))
    sections = {section["id"]: section["items"] for section in body["browse_sections"]}

    assert sync_calls == [20]
    assert [item["title"] for item in sections.get("release_radar", [])] == ["New release"]
    assert calls == list(range(10, 30))
    assert sections["release_radar"][0]["reason_artist"] == "Seed"
    assert all(item["title"] != "New release" for item in sections["albums"])
    assert not body["browse_error"]


def test_release_radar_prefers_album_over_companion_single_and_keeps_standalone_single(monkeypatch):
    album_detail_calls = []

    def get(path, params=None, **kwargs):
        if path == "search/artist":
            return {"data": [artist(1, "Seed")]}
        if path == "artist/1/related":
            return {"data": [
                artist(20, "Album Peer"),
                artist(21, "Standalone Peer"),
                artist(22, "Other Peer A"),
                artist(23, "Other Peer B"),
            ]}
        if path == "artist/1/albums":
            raise AssertionError("Seed discography should not be hydrated when outward artists exist")
        if path == "artist/20/albums":
            return {"data": [
                {"id": 2001, "title": "The Moth", "record_type": "album", "release_date": "2026-11-06"},
                {"id": 2002, "title": "Advance Single", "record_type": "single", "release_date": "2026-10-21"},
                {"id": 2003, "title": "Post Release Single", "record_type": "single", "release_date": "2026-11-12"},
            ]}
        if path == "artist/21/albums":
            return {"data": [
                {"id": 2101, "title": "Old Album", "record_type": "album", "release_date": "2026-09-15"},
                {"id": 2102, "title": "Standalone Single", "record_type": "single", "release_date": "2026-11-20"},
            ]}
        if path == "artist/22/albums":
            return {"data": [{"id": 2201, "title": "Other A LP", "record_type": "album", "release_date": "2026-11-10"}]}
        if path == "artist/23/albums":
            return {"data": [{"id": 2301, "title": "Other B LP", "record_type": "album", "release_date": "2026-11-05"}]}
        if path.startswith("album/"):
            album_detail_calls.append(path)
            return {"id": int(path.split("/")[1])}
        raise AssertionError(path)

    monkeypatch.setattr(deezer, "get", get)
    body = build_browse_sections(["Seed"], today=datetime.date(2026, 11, 26))
    sections = {sec["id"]: sec["items"] for sec in body["browse_sections"]}
    radar = sections["release_radar"]
    assert [item["title"] for item in radar] == [
        "Standalone Single",
        "Other A LP",
        "The Moth",
        "Other B LP",
    ]
    assert "album/2002" not in album_detail_calls
    assert "album/2003" not in album_detail_calls
    assert "album/2101" not in album_detail_calls


def test_release_radar_widens_window_from_sqlite_when_45d_is_sparse(monkeypatch):
    from shared.database import instance_db

    db = instance_db()
    ref_today = datetime.date(2026, 11, 26)
    now_ts = int(datetime.datetime(2026, 11, 26, tzinfo=datetime.timezone.utc).timestamp())
    db.upsert_graph_nodes([
        {"deezer_artist_id": "1", "name": "Seed", "literal_key": "seed", "folded_key": "seed",
         "related_synced_at": now_ts, "releases_synced_at": now_ts},
        *[
            {"deezer_artist_id": str(aid), "name": f"Peer {aid}", "literal_key": f"peer {aid}",
             "folded_key": f"peer {aid}", "releases_synced_at": now_ts}
            for aid in range(10, 15)
        ],
    ], now=now_ts)
    db.replace_similarity_edges(
        "1",
        "deezer",
        [(str(aid), idx + 1, 1.0 - idx * 0.1) for idx, aid in enumerate(range(10, 15))],
        now_ts,
    )
    releases = {
        "10": ("1001", "Fresh 6d", "album", "2026-11-20"),
        "11": ("1101", "Window 67d", "album", "2026-09-20"),
        "12": ("1201", "Window 86d", "ep", "2026-09-01"),
        "13": ("1301", "Window 134d", "album", "2026-07-15"),
        "14": ("1401", "Too Old 239d", "album", "2026-04-01"),
    }
    for aid, (alb_id, title, rtype, rel_date) in releases.items():
        db.upsert_artist_releases(
            aid,
            [{
                "deezer_album_id": alb_id,
                "title": title,
                "artist_credit": f"Peer {aid}",
                "credit_verified": True,
                "record_type": rtype,
                "release_date": rel_date,
            }],
            now_ts,
        )

    monkeypatch.setattr(deezer, "get", lambda *a, **k: (_ for _ in ()).throw(AssertionError("unexpected network call")))
    body = build_browse_sections(["Seed"], limit=10, today=ref_today)
    sections = {sec["id"]: sec["items"] for sec in body["browse_sections"]}
    radar = sections["release_radar"]
    assert [item["title"] for item in radar] == [
        "Fresh 6d",
        "Window 67d",
        "Window 86d",
        "Window 134d",
    ]
    assert [item["is_new"] for item in radar] == [True, False, False, False]

    # Once 90d reaches min_items=4, the 180d fallback is not triggered.
    db.upsert_artist_releases(
        "14",
        [{
            "deezer_album_id": "1402",
            "title": "Window 77d",
            "artist_credit": "Peer 14",
            "credit_verified": True,
            "record_type": "single",
            "release_date": "2026-09-10",
        }],
        now_ts + 1,
    )
    body_90 = build_browse_sections(["Seed"], limit=10, today=ref_today)
    radar_90 = {sec["id"]: sec["items"] for sec in body_90["browse_sections"]}["release_radar"]
    assert [item["title"] for item in radar_90] == [
        "Fresh 6d",
        "Window 67d",
        "Window 77d",
        "Window 86d",
    ]


def test_release_radar_excludes_only_home_top35_profile_not_tail_artists(tmp_path, monkeypatch):
    from shared.api.routes import discovery_feed as route
    from shared.database import instance_db
    from shared.discovery_intelligence import emit_discovery_event
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
                artist=f"Home Core {i:02d}",
                album=f"Album {i}",
                duration=180,
                file_hash=f"h{i}",
                original_filename=f"t{i}.mp3",
                file_size=100,
                bitrate=320,
                format="mp3",
            )
            for i in range(1, 36)
        ]
        # Boost artist 1..35 above the tail artist via library + active play events.
        now_ts = int(datetime.datetime.now(datetime.timezone.utc).timestamp())
        for i in range(1, 36):
            emit_discovery_event(
                "music_play_completed",
                {"title": f"Song {i}", "artist": f"Home Core {i:02d}", "source": "library"},
                created_at=now_ts - i,
            )
        # Rank 36+ tail artist: single passive autoplay event (effective_score = 0.225 < 0.25, outside Home Top 35).
        emit_discovery_event(
            "music_played_30s",
            {"title": "Auto Song", "artist": "Tail Passive", "source": "autoplay"},
            created_at=now_ts - 100,
        )

        db = instance_db()
        db.upsert_graph_nodes([
            *[
                {
                    "deezer_artist_id": str(1000 + i),
                    "name": f"Home Core {i:02d}",
                    "literal_key": f"home core {i:02d}",
                    "folded_key": f"home core {i:02d}",
                    "related_synced_at": now_ts,
                    "releases_synced_at": now_ts,
                }
                for i in range(1, 36)
            ],
            {
                "deezer_artist_id": "9001",
                "name": "Tail Passive",
                "literal_key": "tail passive",
                "folded_key": "tail passive",
                "related_synced_at": now_ts,
                "releases_synced_at": now_ts,
            },
        ], now=now_ts)
        # Seed #1 points to Home Core 35 (inside Top 35) and Tail Passive (rank #36).
        db.replace_similarity_edges(
            "1001",
            "deezer",
            [("1035", 1, 1.0), ("9001", 2, 0.9)],
            now_ts,
        )
        recent_date = datetime.date.today().isoformat()
        db.upsert_artist_releases(
            "1035",
            [{
                "deezer_album_id": "51035",
                "title": "Home Core 35 LP",
                "artist_credit": "Home Core 35",
                "credit_verified": True,
                "record_type": "album",
                "release_date": recent_date,
            }],
            now_ts,
        )
        db.upsert_artist_releases(
            "9001",
            [{
                "deezer_album_id": "59001",
                "title": "Tail Passive LP",
                "artist_credit": "Tail Passive",
                "credit_verified": True,
                "record_type": "album",
                "release_date": recent_date,
            }],
            now_ts,
        )

        lib = SimpleNamespace(
            metadata=LibraryMetadata(version=1, tracks=tracks, playlists={}, settings={}),
            refresh_if_stale=lambda: None,
        )
        monkeypatch.setattr(
            route,
            "_get_api",
            lambda: {
                "get_library": lambda: lib,
                "favourite_library_ids": lambda: [t.id for t in tracks],
                "emit_to_user": lambda *a, **kw: None,
            },
        )
        monkeypatch.setattr(deezer, "get", lambda path, params=None, **kw: {"data": []})
        monkeypatch.setattr(route, "_deezer_json", lambda path, params=None, ttl_sec=None: {"data": []})

        body = route._build_discovery_feed_body(limit=10, include_external=True)
        sections = {sec["id"]: sec["items"] for sec in body["browse_sections"]}
        radar_titles = [item["title"] for item in sections.get("release_radar", [])]
        assert "Tail Passive LP" in radar_titles
        assert "Home Core 35 LP" not in radar_titles
    finally:
        reset_runtime()


def test_home_new_releases_180d_taste_profile_ignores_pins_credits_contributors_and_route(monkeypatch):
    from flask import Flask
    from player.saved_entities import set_saved
    from shared.api.routes import discovery_feed as route
    from shared.models import LibraryMetadata, Track

    ref_today = datetime.date(2026, 11, 22)
    album_detail_calls = []

    def get(path, params=None, **kwargs):
        if path == "search/artist":
            q = params["q"]
            if q == "Pinned Only Band":
                raise AssertionError("Pinned bookmark artist must never be resolved for Home New Releases")
            if q == "Ennio Morricone":
                return {"data": [artist(1536, "Ennio Morricone")]}
            if q == "Solo Composer":
                return {"data": [artist(777, "Solo Composer")]}
            if q == "Edge Artist":
                return {"data": [artist(888, "Edge Artist")]}
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
        if path == "artist/888/albums":
            return {"data": [
                {"id": 8881, "title": "Edge 180", "record_type": "single", "release_date": "2026-05-26"},
                {"id": 8882, "title": "Too Old 181", "record_type": "album", "release_date": "2026-05-25"},
            ]}
        if path == "album/1126150202":
            album_detail_calls.append(path)
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
        if path == "album/8881":
            return {"id": 8881, "title": "Edge 180", "contributors": [{"id": 888, "name": "Edge Artist", "role": "Main"}]}
        raise AssertionError(path)

    # Pinned bookmark must carry zero weight on Home New Releases.
    set_saved(
        {
            "kind": "artist",
            "name": "Pinned Only Band",
            "artist": "",
            "cover": "",
            "destination": "/artist/Pinned%20Only%20Band?deezer_id=999",
        },
        True,
    )
    tracks = [
        Track(id="t1", title="Tema", artist="Ennio Morricone", album="OST", duration=180, file_hash="h1", original_filename="1.mp3", file_size=100, bitrate=320, format="mp3"),
        Track(id="t2", title="Piece", artist="Solo Composer", album="LP", duration=180, file_hash="h2", original_filename="2.mp3", file_size=100, bitrate=320, format="mp3"),
        Track(id="t3", title="Edge", artist="Edge Artist", album="EP", duration=180, file_hash="h3", original_filename="3.mp3", file_size=100, bitrate=320, format="mp3"),
    ]
    lib = SimpleNamespace(
        metadata=LibraryMetadata(version=1, tracks=tracks, playlists={}, settings={}),
        refresh_if_stale=lambda: None,
    )
    monkeypatch.setattr(deezer, "get", get)
    monkeypatch.setattr(
        route,
        "_get_api",
        lambda: {"get_library": lambda: lib, "favourite_library_ids": lambda: ["t1", "t2", "t3"], "emit_to_user": lambda *a, **k: None},
    )

    body = route.build_home_new_releases(limit=12, sync_inline=True, today=ref_today)
    items = body["items"]
    assert [item["title"] for item in items] == [
        "Midnight Jazz Confidential",
        "Solo Work",
        "Horror Cinema Club",
        "Edge 180",
    ]
    assert [item["is_new"] for item in items] == [True, True, True, False]
    assert all(item["reason_artist"] == "" for item in items)
    assert items[0]["artist"] == "Piero Piccioni, Ennio Morricone, Nino Rota, Philippe Sarde"
    assert items[0]["external_ids"]["deezer_artist_id"] == "1536"
    assert items[1]["artist"] == "Solo Composer"
    # Timeout fallback preserves owner name cleanly.
    assert items[2]["artist"] == "Ennio Morricone"

    # Cached credit avoids re-fetching album/1126150202 on subsequent calls, and Flask route serves JSON.
    calls_before = len(album_detail_calls)
    monkeypatch.setattr(deezer, "get", lambda *a, **k: (_ for _ in ()).throw(AssertionError("unexpected Deezer hit")))
    second = route.build_home_new_releases(limit=12, today=ref_today)
    assert len(album_detail_calls) == calls_before
    assert second["items"][0]["artist"] == "Piero Piccioni, Ennio Morricone, Nino Rota, Philippe Sarde"

    app = Flask(__name__)
    app.register_blueprint(route.discovery_bp)
    resp = app.test_client().get("/api/discovery/music/new-releases?limit=12")
    assert resp.status_code == 200
    payload = resp.get_json()
    assert "items" in payload and "revalidating" in payload


def test_home_new_releases_cooldown_preserves_undecorated_ids_and_avoids_sync_fanout(monkeypatch):
    from shared.api.routes import discovery_common as common
    from shared.api.routes import discovery_feed as route
    from shared.database import instance_db
    from shared.discovery_profile import build_artist_taste_profile
    from shared.models import LibraryMetadata, Track

    common._NEW_RELEASES_SYNCED_AT.clear()
    common._UNRESOLVED_ARTIST_UNTIL.clear()

    ref_today = datetime.date(2026, 11, 22)
    emitted = []
    search_calls = []

    def get(path, params=None, **kwargs):
        if path == "search/artist":
            q = params["q"]
            search_calls.append(q)
            if q == "Blue Oyster Cult":
                return {"data": [{"id": 20, "name": "Blue Öyster Cult", "nb_fan": 500000, "picture_big": "https://img/20"}]}
            return {"data": []}
        if path == "artist/20/albums":
            return {"data": [{"id": 2001, "title": "Fire of Unknown", "record_type": "album", "release_date": "2026-11-15"}]}
        if path == "album/2001":
            raise AssertionError("Synchronous HTTP path must not resolve album credits blocking the response")
        raise AssertionError(path)

    tracks = [
        Track(id="t1", title="Reaper", artist="Blue Oyster Cult", album="LP", duration=180, file_hash="h1", original_filename="1.mp3", file_size=100, bitrate=320, format="mp3"),
        Track(id="t2", title="Demo", artist="Local Bedroom Act", album="Tape", duration=180, file_hash="h2", original_filename="2.mp3", file_size=100, bitrate=320, format="mp3"),
    ]
    lib = SimpleNamespace(
        metadata=LibraryMetadata(version=1, tracks=tracks, playlists={}, settings={}),
        refresh_if_stale=lambda: None,
    )
    monkeypatch.setattr(deezer, "get", get)
    monkeypatch.setattr(
        route,
        "_get_api",
        lambda: {"get_library": lambda: lib, "favourite_library_ids": lambda: ["t1"], "emit_to_user": lambda *a, **k: emitted.append((a, k))},
    )

    # 1) Pre-populate an unverified cached album (as if hydrated by Discover) and run sync_inline with only Local Bedroom Act.
    inst = instance_db()
    inst.upsert_graph_nodes([{
        "deezer_artist_id": "20",
        "name": "Blue Öyster Cult",
        "literal_key": "blue öyster cult",
        "folded_key": "blue oyster cult",
        "nb_fan": 500000,
        "releases_synced_at": int(route.time.time()),
    }])
    inst.upsert_artist_releases("20", [{
        "deezer_album_id": "2001",
        "title": "Fire of Unknown",
        "artist_credit": "Blue Öyster Cult",
        "credit_verified": False,
        "record_type": "album",
        "release_date": "2026-11-15",
    }], int(route.time.time()))

    # Non-inline synchronous read with Blue Oyster Cult not yet linked in profile still does 0 blocking album/2001 calls,
    # and once resolved via inline sync for Local Bedroom Act only (unchanged), does not emit a false discovery_feed_ready.
    common._NEW_RELEASES_SYNCED_AT.clear()
    lib.metadata = LibraryMetadata(version=1, tracks=[tracks[1]], playlists={}, settings={})
    res_unres = route.build_home_new_releases(limit=12, sync_inline=True, today=ref_today)
    assert res_unres["items"] == []
    assert emitted == []
    assert not res_unres["revalidating"]
    # Second non-inline read stays on cooldown/negative cache without revalidating.
    res_unres2 = route.build_home_new_releases(limit=12, sync_inline=False, today=ref_today)
    assert not res_unres2["revalidating"]

    # 2) Undecorated artist ("Blue Oyster Cult") retains resolved deezer_artist_id across profile rebuilds,
    # and synchronous build_home_new_releases skips album/2001 HTTP lookup even though credit_verified=0.
    lib.metadata = LibraryMetadata(version=1, tracks=[tracks[0]], playlists={}, settings={})
    common._NEW_RELEASES_SYNCED_AT.clear()
    first = route.build_home_new_releases(limit=12, sync_inline=True, today=ref_today)
    assert [item["title"] for item in first["items"]] == ["Fire of Unknown"]
    assert any(args[0] == "discovery_feed_ready" for args, _ in emitted)
    rebuilt = build_artist_taste_profile(lib.metadata, ["t1"], persist=True)
    assert rebuilt[0].deezer_artist_id == "20"
    monkeypatch.setattr(deezer, "get", lambda *a, **k: (_ for _ in ()).throw(AssertionError("unexpected sync Deezer call")))
    cached = route.build_home_new_releases(limit=12, sync_inline=False, today=ref_today)
    assert [item["title"] for item in cached["items"]] == ["Fire of Unknown"]
    assert not cached["revalidating"]


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
            today=datetime.date(2026, 11, 22),
        )
        sections = {sec["id"]: sec["items"] for sec in body["browse_sections"]}
        assert [item["title"] for item in sections["artists"]] == ["Good Band", "Disliked Band"]
        assert [item["title"] for item in sections["release_radar"]] == ["Good New"]

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
