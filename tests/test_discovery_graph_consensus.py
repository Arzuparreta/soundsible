"""Unit tests for persistent similarity graph, consensus scoring, IDF, and MMR (Phase 2)."""

from __future__ import annotations

import datetime

from shared.database import instance_db
from shared.discovery_browse import build_browse_sections
from shared.discovery_graph_store import (
    project_youtube_mix_edges,
    resolve_artist_node,
    score_consensus_candidates,
    select_diverse_track_anchors,
    select_mmr_diverse,
)
from shared.discovery_profile import ArtistProfileEntry
from shared.models import LibraryMetadata, Track
from shared.providers import deezer


def test_consensus_beats_single_seed_and_hub_penalty_damps_megahubs():
    now = 1_800_000_000
    db = instance_db()
    nodes = [
        {"deezer_artist_id": "1", "name": "Seed A", "literal_key": "seed a", "folded_key": "seed a", "nb_fan": 50_000, "related_synced_at": now},
        {"deezer_artist_id": "2", "name": "Seed B", "literal_key": "seed b", "folded_key": "seed b", "nb_fan": 45_000, "related_synced_at": now},
        {"deezer_artist_id": "3", "name": "Seed C", "literal_key": "seed c", "folded_key": "seed c", "nb_fan": 40_000, "related_synced_at": now},
        {"deezer_artist_id": "10", "name": "Megahub Solo", "literal_key": "megahub solo", "folded_key": "megahub solo", "nb_fan": 25_000_000},
        {"deezer_artist_id": "11", "name": "Consensus Indie", "literal_key": "consensus indie", "folded_key": "consensus indie", "nb_fan": 60_000},
    ]
    db.upsert_graph_nodes(nodes, now=now)
    # Seed A ranks Megahub #1 and Consensus Indie #3; Seeds B and C also vote for Consensus Indie.
    db.replace_similarity_edges("1", "deezer", [("10", 1, 1.0), ("11", 3, 0.50)], now)
    db.replace_similarity_edges("2", "deezer", [("11", 2, 0.63)], now)
    db.replace_similarity_edges("3", "deezer", [("11", 2, 0.63)], now)
    # Extra unrelated sources linking to Megahub increase its in-degree IDF penalty.
    for extra in ("901", "902", "903", "904", "905", "906"):
        db.replace_similarity_edges(extra, "deezer", [("10", 1, 1.0)], now)

    scored = score_consensus_candidates(
        {"1": 10.0, "2": 9.0, "3": 8.0},
        {"1": "Seed A", "2": "Seed B", "3": "Seed C"},
        now=now,
    )
    assert [item["title"] for item in scored] == ["Consensus Indie", "Megahub Solo"]
    assert scored[0]["supporting_seeds"] == 3


def test_mmr_balances_distinct_taste_clusters_and_anchors():
    now = 1_800_000_000
    db = instance_db()
    # Two disjoint taste worlds: electronic (100s) and jazz (200s)
    elec_neighbors = {"101", "102", "103"}
    jazz_neighbors = {"201", "202", "203"}
    nodes = [
        {"deezer_artist_id": str(aid), "name": f"Elec {aid}", "literal_key": f"elec {aid}", "folded_key": f"elec {aid}", "nb_fan": 10000}
        for aid in range(100, 108)
    ] + [
        {"deezer_artist_id": str(aid), "name": f"Jazz {aid}", "literal_key": f"jazz {aid}", "folded_key": f"jazz {aid}", "nb_fan": 10000}
        for aid in range(200, 208)
    ]
    db.upsert_graph_nodes(nodes, now=now)
    for cid in ("101", "102", "103", "104"):
        db.replace_similarity_edges(cid, "deezer", [(n, i + 1, 0.8) for i, n in enumerate(sorted(elec_neighbors - {cid}))], now)
    for cid in ("201", "202", "203", "204"):
        db.replace_similarity_edges(cid, "deezer", [(n, i + 1, 0.8) for i, n in enumerate(sorted(jazz_neighbors - {cid}))], now)

    candidates = [
        {"id": "deezer:artist:101", "title": "Elec 101", "external_ids": {"deezer_artist_id": "101"}, "score": 1.00, "_supporting_seed_ids": {"100"}, "_demoted": False},
        {"id": "deezer:artist:102", "title": "Elec 102", "external_ids": {"deezer_artist_id": "102"}, "score": 0.99, "_supporting_seed_ids": {"100"}, "_demoted": False},
        {"id": "deezer:artist:103", "title": "Elec 103", "external_ids": {"deezer_artist_id": "103"}, "score": 0.98, "_supporting_seed_ids": {"100"}, "_demoted": False},
        {"id": "deezer:artist:201", "title": "Jazz 201", "external_ids": {"deezer_artist_id": "201"}, "score": 0.92, "_supporting_seed_ids": {"200"}, "_demoted": False},
    ]
    diversified = select_mmr_diverse(candidates, limit=3)
    titles = [c["title"] for c in diversified]
    assert titles[0] == "Elec 101"
    # Jazz 201 enters ahead of redundant Elec 103 because Elec 101/102 share the exact same neighborhood.
    assert "Jazz 201" in titles

    profile = [
        ArtistProfileEntry("elec 101", "elec 101", "Elec 101", "101", 8.0, 10.0, 1.0, 10.0, 5, 5, 5.0, 0.0, 0.0, now, now),
        ArtistProfileEntry("elec 102", "elec 102", "Elec 102", "102", 9.0, 8.0, 1.0, 9.5, 4, 4, 4.0, 0.0, 0.0, now, now),
        ArtistProfileEntry("jazz 201", "jazz 201", "Jazz 201", "201", 8.5, 6.0, 1.0, 8.0, 3, 3, 3.0, 0.0, 0.0, now, now),
    ]
    anchors = select_diverse_track_anchors(
        profile,
        {
            "elec 101": {"deezer_artist_id": "101"},
            "elec 102": {"deezer_artist_id": "102"},
            "jazz 201": {"deezer_artist_id": "201"},
        },
        limit=2,
    )
    assert [a.display_name for a in anchors] == ["Elec 101", "Jazz 201"]


def test_graph_caches_in_instance_db_and_projects_youtube_mixes(monkeypatch):
    calls: list[str] = []

    def get(path, params=None, **kwargs):
        calls.append(path)
        if path == "search/artist":
            q = params["q"]
            aid = 1 if q == "Seed One" else 2
            return {"data": [{"id": aid, "name": q, "nb_fan": 50000, "picture_big": f"https://img/{aid}"}]}
        if path == "artist/1/related":
            return {"data": [{"id": 10, "name": "Neighbor Ten", "nb_fan": 20000, "picture_big": "https://img/10"}]}
        if path == "artist/2/related":
            return {"data": [{"id": 10, "name": "Neighbor Ten", "nb_fan": 20000, "picture_big": "https://img/10"}]}
        if path.endswith("/albums"):
            return {"data": []}
        raise AssertionError(path)

    monkeypatch.setattr(deezer, "get", get)
    body1 = build_browse_sections(["Seed One", "Seed Two"], today=datetime.date(2026, 11, 26))
    assert any(sec["id"] == "artists" for sec in body1["browse_sections"])
    first_call_count = len(calls)

    # Second build reads nodes and related edges from instance.db without re-hitting search/artist or /related.
    calls.clear()
    body2 = build_browse_sections(["Seed One", "Seed Two"], today=datetime.date(2026, 11, 26))
    assert first_call_count >= 4
    assert "search/artist" not in calls
    assert "artist/1/related" not in calls
    assert "artist/2/related" not in calls
    assert [a["title"] for a in body2["browse_sections"][0]["items"]] == ["Neighbor Ten"]

    # YouTube cached related mix projecting onto known artist nodes uses 0 network calls and adds a provider edge.
    db = instance_db()
    db.upsert_graph_nodes(
        [{"deezer_artist_id": "20", "name": "YT Match", "literal_key": "yt match", "folded_key": "yt match", "nb_fan": 8000}]
    )
    db.set_related_mix(
        "vid12345678",
        [
            {"id": "rec11111111", "title": "Song", "artist": "YT Match"},
            {"id": "rec22222222", "title": "Vlog", "artist": "Random Channel", "artist_is_channel": True},
        ],
    )
    meta = LibraryMetadata(
        version=1,
        tracks=[
            Track(
                id="t1",
                title="Track",
                artist="Seed One",
                album="Album",
                duration=180,
                file_hash="h1",
                original_filename="t1.mp3",
                file_size=100,
                bitrate=320,
                format="mp3",
                youtube_id="vid12345678",
            )
        ],
        playlists={},
        settings={},
    )
    seed_node = resolve_artist_node("Seed One")
    added = project_youtube_mix_edges(meta, [seed_node])
    assert added == 1
    edges = db.get_similarity_edges_for_sources(["1"], providers=["youtube"])
    assert len(edges) == 1
    assert edges[0]["target_artist_id"] == "20"


def test_anchor2_prefers_active_short_term_and_get_related_mixes_batches_large_libraries():
    from shared.discovery_graph_store import select_diverse_track_anchors
    from shared.discovery_profile import ArtistProfileEntry

    now_ts = 1_700_000_000

    def entry(key: str, *, short_term: float, long_term: float, eff: float) -> ArtistProfileEntry:
        return ArtistProfileEntry(
            artist_key=key,
            literal_key=key,
            display_name=key,
            deezer_artist_id="",
            short_term_score=short_term,
            long_term_score=long_term,
            library_prior=eff,
            effective_score=eff,
            distinct_days=1,
            distinct_tracks=1,
            active_plays=0.0,
            passive_plays=0.0,
            early_skips=0.0,
            last_listened_at=now_ts,
            updated_at=now_ts,
        )

    anchors = select_diverse_track_anchors(
        [
            entry("Core Long", short_term=0.5, long_term=9.0, eff=8.0),
            entry("Dormant Library", short_term=0.0, long_term=2.0, eff=5.0),
            entry("Active Recent", short_term=1.5, long_term=1.0, eff=2.0),
        ],
        {},
        limit=2,
    )
    assert [a.display_name for a in anchors] == ["Core Long", "Active Recent"]

    db = instance_db()
    db.set_related_mix("vid00000001", [{"id": "rec11111111", "title": "Song", "artist": "X"}])
    many_ids = [f"vid{i:08d}" for i in range(1, 1205)]
    res = db.get_related_mixes(many_ids)
    assert "vid00000001" in res
