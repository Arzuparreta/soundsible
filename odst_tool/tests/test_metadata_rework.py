import tempfile

from shared.api import normalize_youtube_url, parse_intake_item
from odst_tool.metadata_harmonizer import MetadataHarmonizer
from odst_tool.metadata_scorer import metadata_query_fingerprint, decide_consensus
from shared.database import DatabaseManager


def test_normalize_youtube_url_strips_playlist_params():
    raw = "https://music.youtube.com/watch?v=abc123&list=PLx&index=4"
    assert normalize_youtube_url(raw) == "https://music.youtube.com/watch?v=abc123"


def test_parse_intake_item_accepts_typed_youtube_url():
    item, err = parse_intake_item({
        "source_type": "youtube_url",
        "song_str": "https://youtu.be/abc123?t=10"
    })
    assert err is None
    assert item["source_type"] == "youtube_url"
    assert "watch?v=abc123" in item["song_str"]


def test_parse_intake_item_rejects_invalid_typed_url():
    item, err = parse_intake_item({
        "source_type": "youtube_url",
        "song_str": "https://example.com/song"
    })
    assert item is None
    assert err is not None


def test_parse_intake_item_rejects_playlist_only_url():
    item, err = parse_intake_item({
        "source_type": "youtube_url",
        "song_str": "https://music.youtube.com/watch?list=RDAMVMH-wIXAtEi2w"
    })
    assert item is None
    assert "missing v" in err.lower()


def test_parse_intake_item_requires_ytmusic_snapshot():
    item, err = parse_intake_item({
        "source_type": "ytmusic_search",
        "song_str": "https://music.youtube.com/watch?v=HeYjxXvEvzU",
        "metadata_evidence": {"video_id": "HeYjxXvEvzU"}
    })
    assert item is None
    assert "requires metadata_evidence" in err


def test_metadata_query_fingerprint_is_deterministic():
    fp1 = metadata_query_fingerprint("Numb", "Linkin Park", 185)
    fp2 = metadata_query_fingerprint(" numb ", "LINKIN PARK", 185)
    assert fp1 == fp2


def test_consensus_pending_review_when_single_source():
    base = {"title": "Numb", "artist": "Linkin Park", "album": "", "duration_sec": 185}
    spotify = [{"title": "Numb", "artist": "Linkin Park", "album": "Meteora", "duration_sec": 186, "catalog_source": "spotify_web"}]
    result = decide_consensus(base, spotify_web_candidates=spotify)
    assert result["metadata_state"] in {"pending_review", "fallback_youtube"}


def test_consensus_auto_resolved_on_multi_provider_agreement():
    base = {"title": "Basureta (Tiempos Raros)", "artist": "Kase.O", "album": "", "duration_sec": 371}
    spotify = [{
        "title": "Basureta (Tiempos Raros)",
        "artist": "Kase.O",
        "album": "El Círculo (Versión Exclusiva de Spotify)",
        "duration_sec": 371,
        "catalog_source": "spotify_web",
    }]
    mb = [{
        "title": "Basureta (Tiempos Raros)",
        "artist": "Kase.O",
        "album": "El Círculo",
        "duration_sec": 371,
        "catalog_source": "musicbrainz",
    }]
    result = decide_consensus(base, spotify_web_candidates=spotify, musicbrainz_candidates=mb)
    assert result["metadata_state"] == "auto_resolved"


def test_harmonizer_returns_state_and_fingerprint():
    raw = {
        "title": "Numb [4K UPGRADE] – Linkin Park",
        "artist": "Linkin Park",
        "album": "",
        "duration_sec": 185,
    }
    out = MetadataHarmonizer.harmonize(raw, source="youtube_url")
    assert out["metadata_state"] in {"auto_resolved", "pending_review", "fallback_youtube"}
    assert out["metadata_query_fingerprint"]


def test_harmonizer_strips_trailing_artist_from_youtube_title():
    raw = {
        "title": "Numb [4K UPGRADE] – Linkin Park",
        "artist": "Linkin Park",
        "album": "",
    }
    out = MetadataHarmonizer.harmonize(raw, source="youtube_url")
    assert out["title"] == "Numb"
    assert out["artist"] == "Linkin Park"
    assert out["album"] == "Singles"


def test_harmonizer_parses_noisy_youtube_title_and_channel(monkeypatch):
    raw = {
        "title": "KASE.O - 16. BASURETA (TIEMPOS RAROS) Prod JAVATO JONES y GONZALO LASHERAS",
        "artist": "KaseO TV Oficial",
        "album": "",
        "duration_sec": 371,
    }

    def fake_candidates(_cls, _artist, _title):
        return {
            "musicbrainz": [{
                "title": "Basureta (Tiempos Raros)",
                "artist": "Kase.O",
                "album": "El Círculo",
                "duration_sec": 371,
                "catalog_source": "musicbrainz",
                "catalog_id": "mb_1",
            }],
            "spotify_web": [{
                "title": "Basureta (Tiempos Raros)",
                "artist": "Kase.O",
                "album": "El Círculo (Versión Exclusiva de Spotify)",
                "duration_sec": 371,
                "catalog_source": "spotify_web",
                "catalog_id": "sp_1",
            }],
            "itunes": [],
        }

    monkeypatch.setattr(MetadataHarmonizer, "_gather_provider_candidates", fake_candidates)
    out = MetadataHarmonizer.harmonize(raw, source="youtube_url")
    assert out["metadata_state"] == "auto_resolved"
    assert out["title"].lower().startswith("basureta")
    assert out["artist"].lower() == "kase.o"


def test_harmonizer_enriches_album_without_core_overwrite(monkeypatch):
    raw = {
        "title": "Basureta (Tiempos Raros)",
        "artist": "Kase.O",
        "album": "",
        "duration_sec": 371,
    }

    def fake_candidates(_cls, _artist, _title):
        return {
            "musicbrainz": [],
            "spotify_web": [{
                "title": "Basureta (Tiempos Raros)",
                "artist": "Kase.O",
                "album": "El Círculo (Versión Exclusiva de Spotify)",
                "duration_sec": 371,
                "catalog_source": "spotify_web",
                "catalog_id": "sp_2",
                "cover_url": "https://example.com/cover.jpg",
            }],
            "itunes": [],
        }

    monkeypatch.setattr(MetadataHarmonizer, "_gather_provider_candidates", fake_candidates)
    out = MetadataHarmonizer.harmonize(raw, source="youtube_url")
    assert out["title"] == "Basureta (Tiempos Raros)"
    assert out["artist"] == "Kase.O"
    assert out["album"].startswith("El Círculo")


def test_database_initializes_metadata_migration_tables():
    with tempfile.TemporaryDirectory() as td:
        db = DatabaseManager(db_path=f"{td}/library.db")
        with db._get_connection() as conn:
            jobs = conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='metadata_migration_jobs'"
            ).fetchone()
            audit = conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='metadata_migration_audit'"
            ).fetchone()
            review = conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='metadata_review_queue'"
            ).fetchone()
        assert jobs is not None
        assert audit is not None
        assert review is not None


def test_channel_variants_resolve_album_when_title_has_no_artist(monkeypatch):
    """
    Test that channel-derived variants allow album resolution even when title doesn't contain "ARTIST - ".
    This is the Kase.O / El Círculo case: channel "KaseO TV Oficial" + title "Basureta" should resolve.
    """
    raw = {
        "title": "Basureta (Tiempos Raros)",
        "artist": "KaseO TV Oficial",
        "album": "",
        "duration_sec": 371,
    }

    call_count = {"count": 0}
    def fake_candidates(_cls, artist, _title):
        call_count["count"] += 1
        # First call might be with "KaseO TV Oficial", but variants should trigger calls with "KaseO"
        if "KaseO" in artist or "Kase.O" in artist:
            return {
                "musicbrainz": [{
                    "title": "Basureta (Tiempos Raros)",
                    "artist": "Kase.O",
                    "album": "El Círculo",
                    "duration_sec": 371,
                    "catalog_source": "musicbrainz",
                    "catalog_id": "mb_3",
                    "cover_url": "https://coverartarchive.org/release/mb_3/front",
                }],
                "spotify_web": [{
                    "title": "Basureta (Tiempos Raros)",
                    "artist": "Kase.O",
                    "album": "El Círculo",
                    "duration_sec": 371,
                    "catalog_source": "spotify_web",
                    "catalog_id": "sp_3",
                    "cover_url": "https://example.com/el_circulo.jpg",
                }],
                "itunes": [],
            }
        return {"musicbrainz": [], "spotify_web": [], "itunes": []}

    monkeypatch.setattr(MetadataHarmonizer, "_gather_provider_candidates", fake_candidates)
    out = MetadataHarmonizer.harmonize(raw, source="youtube_url")
    
    # Should have called with variants (at least one call with "KaseO" or "Kase.O")
    assert call_count["count"] > 0
    # Should resolve album from enrichment
    assert out["album"].startswith("El Círculo")
    # Artist should be normalized (either from candidate or variant)
    assert "Kase" in out["artist"] or "kase" in out["artist"].lower()


def test_cover_priority_premium_over_youtube(monkeypatch):
    """Test that premium cover sources (MusicBrainz, Spotify) are preferred over YouTube thumbnails."""
    raw = {
        "title": "Test Song",
        "artist": "Test Artist",
        "album": "",
        "duration_sec": 200,
        "album_art_url": "https://img.youtube.com/vi/abc123/maxresdefault.jpg",
        "is_music_content": False,  # Regular YouTube video
    }

    def fake_candidates(_cls, _artist, _title):
        return {
            "musicbrainz": [{
                "title": "Test Song",
                "artist": "Test Artist",
                "album": "Test Album",
                "duration_sec": 200,
                "catalog_source": "musicbrainz",
                "catalog_id": "mb_4",
                "cover_url": "https://coverartarchive.org/release/mb_4/front",
            }],
            "spotify_web": [],
            "itunes": [],
        }

    monkeypatch.setattr(MetadataHarmonizer, "_gather_provider_candidates", fake_candidates)
    out = MetadataHarmonizer.harmonize(raw, source="youtube_url")
    
    # Should use premium cover, not YouTube thumbnail
    assert "coverartarchive.org" in out["album_art_url"]
    assert "youtube.com" not in out["album_art_url"]


def test_cover_priority_youtube_only_if_music_specific(monkeypatch):
    """Test that YouTube thumbnails are only used for music-specific content when no premium cover exists."""
    raw_music = {
        "title": "Test Song",
        "artist": "Test Artist",
        "album": "",
        "duration_sec": 200,
        "album_art_url": "https://img.youtube.com/vi/abc123/maxresdefault.jpg",
        "is_music_content": True,  # Music-specific upload
    }
    
    raw_regular = {
        "title": "Test Song",
        "artist": "Test Artist",
        "album": "",
        "duration_sec": 200,
        "album_art_url": "https://img.youtube.com/vi/abc123/maxresdefault.jpg",
        "is_music_content": False,  # Regular video
    }

    def fake_candidates(_cls, _artist, _title):
        return {"musicbrainz": [], "spotify_web": [], "itunes": []}

    monkeypatch.setattr(MetadataHarmonizer, "_gather_provider_candidates", fake_candidates)
    
    # Music-specific: should use YouTube thumbnail
    out_music = MetadataHarmonizer.harmonize(raw_music, source="youtube_url")
    assert "youtube.com" in out_music["album_art_url"] or out_music["album_art_url"] == raw_music.get("thumbnail")
    
    # Regular video: should prefer fallback thumbnail, not YouTube album_art_url
    out_regular = MetadataHarmonizer.harmonize(raw_regular, source="youtube_url")
    # Should not use album_art_url (YouTube thumbnail) for regular videos
    assert out_regular["album_art_url"] != raw_regular["album_art_url"] or not out_regular["album_art_url"]


def test_channel_variant_derivation():
    """Test that channel variants are correctly derived from channel-like names."""
    variants = MetadataHarmonizer._derive_channel_search_variants("KaseO TV Oficial")
    assert len(variants) > 0
    assert "KaseO" in variants or any("Kase" in v for v in variants)
    
    variants2 = MetadataHarmonizer._derive_channel_search_variants("Artist - Topic")
    assert len(variants2) > 0
    assert "Artist" in variants2[0]
    
    # Non-channel should return empty
    variants3 = MetadataHarmonizer._derive_channel_search_variants("Kase.O")
    assert len(variants3) == 0  # Not a channel-like name


def test_music_detection():
    """Test music-specific content detection."""
    from odst_tool.youtube_downloader import YouTubeDownloader
    
    # Music-specific: has artist/track fields
    assert YouTubeDownloader._is_music_specific_content({"artist": "Test Artist"}, "https://youtube.com/watch?v=123")
    
    # Music-specific: music.youtube.com domain
    assert YouTubeDownloader._is_music_specific_content({}, "https://music.youtube.com/watch?v=123")
    
    # Music-specific: VEVO channel
    assert YouTubeDownloader._is_music_specific_content({"channel": "ArtistVEVO"}, "")
    
    # Music-specific: Topic channel
    assert YouTubeDownloader._is_music_specific_content({"channel": "Artist - Topic"}, "")
    
    # Not music-specific: regular channel
    assert not YouTubeDownloader._is_music_specific_content({"channel": "Random Channel"}, "")
    
    # Not music-specific: empty
    assert not YouTubeDownloader._is_music_specific_content({}, "")


def test_kase_o_outro_metadata_matching(monkeypatch):
    """
    Regression test for Kase.O Outro case:
    - Title: "KASE.O - 17. OUTRO Prod CRUDO MEANS RAW"
    - Artist: "KaseO TV Oficial"
    - Should resolve to: title="Outro", artist="Kase.O", album="El Círculo"
    """
    raw = {
        "title": "KASE.O - 17. OUTRO Prod CRUDO MEANS RAW",
        "artist": "KaseO TV Oficial",
        "album": "",
        "duration_sec": 196,  # Outro is ~3:16
        "is_music_content": True,
    }

    def fake_candidates(_cls, artist, title):
        # Should receive queries with variants: "Kase.O" or "KaseO" + "OUTRO"
        if ("Kase.O" in artist or "KaseO" in artist) and ("OUTRO" in title.upper() or "Outro" in title):
            return {
                "musicbrainz": [{
                    "title": "Outro",
                    "artist": "Kase.O",
                    "album": "El Círculo",
                    "duration_sec": 196,
                    "catalog_source": "musicbrainz",
                    "catalog_id": "mb_outro",
                    "cover_url": "https://coverartarchive.org/release/mb_outro/front",
                }],
                "spotify_web": [{
                    "title": "Outro",
                    "artist": "Kase.O",
                    "album": "El Círculo",
                    "duration_sec": 196,
                    "catalog_source": "spotify_web",
                    "catalog_id": "sp_outro",
                    "cover_url": "https://example.com/el_circulo.jpg",
                }],
                "itunes": [],
            }
        return {"musicbrainz": [], "spotify_web": [], "itunes": []}

    monkeypatch.setattr(MetadataHarmonizer, "_gather_provider_candidates", fake_candidates)
    out = MetadataHarmonizer.harmonize(raw, source="youtube_url")
    
    # Title should be cleaned to "Outro" (not "KASE.O - 17. OUTRO Prod...")
    assert out["title"].lower() == "outro"
    
    # Artist should be "Kase.O" (not "KaseO TV Oficial")
    assert out["artist"].lower() == "kase.o"
    
    # Album should be "El Círculo" (not "Singles")
    assert "círculo" in out["album"].lower() or "circulo" in out["album"].lower()
    
    # Cover should be from premium source (not YouTube thumbnail)
    assert out["album_art_url"] and ("coverartarchive.org" in out["album_art_url"] or "example.com" in out["album_art_url"])
    
    # Should have high confidence (either auto_resolved or enrichment applied)
    assert out["metadata_state"] in {"auto_resolved", "pending_review"} or out["album"].lower() not in {"singles", "unknown"}
