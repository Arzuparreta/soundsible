from shared.lossless.matching import metadata_match, normalize_text
from shared.lossless.models import LosslessCandidate
from shared.models import Track


def _track(title: str = "Canción", artist: str = "Ártist") -> Track:
    return Track(
        id="track",
        title=title,
        artist=artist,
        album="Album",
        duration=180,
        file_hash="hash",
        original_filename="song.m4a",
        compressed=True,
        file_size=1,
        bitrate=128,
        format="m4a",
        youtube_id="youtube",
    )


def _candidate(
    *, title: str = "Cancion", artist: str = "Artist", duration: int = 182
) -> LosslessCandidate:
    return LosslessCandidate(
        provider="wikimedia",
        source_id="source",
        title=title,
        artist=artist,
        album="Album",
        duration=duration,
        download_url="https://upload.wikimedia.org/song.flac",
        webpage_url="https://commons.wikimedia.org/wiki/File:Song.flac",
        license_url="https://creativecommons.org/licenses/by/4.0/",
        format="flac",
    )


def test_metadata_match_normalizes_accents_and_tolerates_three_seconds():
    assert normalize_text("Árbol") == "arbol"
    assert metadata_match(_track(), _candidate()) is True


def test_metadata_match_rejects_different_version_or_missing_artist():
    assert (
        metadata_match(
            _track(title="Canción (Live)"),
            _candidate(title="Cancion", duration=180),
        )
        is False
    )
    assert metadata_match(_track(), _candidate(artist="")) is False


def test_metadata_match_rejects_duration_outside_strict_window():
    assert metadata_match(_track(), _candidate(duration=184)) is False
