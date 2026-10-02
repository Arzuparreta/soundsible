"""One reader and writer for audio files, tried on real files.

`shared.audio_files` replaced two `AudioProcessor`s: the folder scan's, which
filled gaps with "Unknown …", and the downloader's, which left them blank and
could only read MP3 and FLAC.
"""

import subprocess

import pytest

from shared.audio_files import AudioProcessor
from shared.ffmpeg_runtime import ffmpeg_executable


def _encode(path, *tags):
    metadata = [arg for tag in tags for arg in ("-metadata", tag)]
    subprocess.run(
        [ffmpeg_executable(), "-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.3",
         *metadata, str(path)],
        check=True,
    )
    return path


@pytest.mark.parametrize("suffix", [".mp3", ".flac", ".m4a", ".ogg"])
def test_every_scanned_format_reads_its_tags(tmp_path, suffix):
    path = _encode(tmp_path / f"song{suffix}", "title=A Song", "artist=An Artist", "album=An Album", "date=2001-05-01")

    tags = AudioProcessor.read_tags(str(path))

    assert (tags["title"], tags["artist"], tags["album"]) == ("A Song", "An Artist", "An Album")
    assert tags["year"] == 2001
    assert tags["format"] == suffix.lstrip(".")


def test_reading_leaves_gaps_blank_and_the_library_fills_them(tmp_path):
    path = _encode(tmp_path / "untagged.mp3")

    assert (AudioProcessor.read_tags(str(path))["title"], AudioProcessor.read_tags(str(path))["artist"]) == ("", "")
    metadata = AudioProcessor.extract_metadata(str(path))
    assert (metadata["title"], metadata["artist"], metadata["album"]) == ("untagged", "Unknown Artist", "Unknown Album")


def test_a_malformed_date_costs_only_the_year(tmp_path):
    # The scan's reader used to raise on int("May 2001") and throw away every
    # tag the file had.
    path = _encode(tmp_path / "odd.flac", "title=Kept", "date=sometime")

    tags = AudioProcessor.read_tags(str(path))

    assert tags["title"] == "Kept"
    assert tags["year"] is None


def test_setting_an_m4a_album_artist_keeps_its_artist(tmp_path):
    # The m4a branch wrote the album artist into the artist atom, and its
    # plain-MP4 keys made every m4a edit fail.
    path = _encode(tmp_path / "song.m4a", "title=Old", "artist=The Artist")

    assert AudioProcessor.update_tags(str(path), {"title": "New", "album_artist": "Various Artists"})

    tags = AudioProcessor.read_tags(str(path))
    assert (tags["title"], tags["artist"], tags["album_artist"]) == ("New", "The Artist", "Various Artists")


def test_audio_details_report_length_and_size(tmp_path):
    path = _encode(tmp_path / "song.mp3")

    duration, bitrate, size = AudioProcessor.audio_details(str(path))

    assert duration == 0  # 0.3 s rounds down
    assert bitrate > 0
    assert size == path.stat().st_size
