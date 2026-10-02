"""A song downloaded from an album page lands on that album, in its place."""

from odst_tool.youtube_downloader import YouTubeDownloader


def _download(tmp_path, monkeypatch, *, tags: dict, hint: dict):
    downloader = YouTubeDownloader(output_dir=tmp_path)
    temporary = tmp_path / "temp" / "download.mp3"
    temporary.write_bytes(b"audio")
    embedded = []

    monkeypatch.setattr(downloader, "_download_audio", lambda *_args, **_kwargs: temporary)
    monkeypatch.setattr("shared.audio_files.AudioProcessor.audio_details", lambda _path: (180, 320, 5))
    monkeypatch.setattr("shared.audio_files.AudioProcessor.read_tags", lambda _path: dict(tags))
    monkeypatch.setattr(
        "shared.audio_files.AudioProcessor.embed_metadata",
        lambda _path, metadata, _cover: embedded.append(dict(metadata)),
    )
    monkeypatch.setattr("shared.audio_files.AudioProcessor.calculate_hash", lambda _path: "content-hash")

    track = downloader.process_video("https://www.youtube.com/watch?v=abcdefghijk", metadata_hint=hint)
    return track, embedded[0]


def test_the_record_it_was_saved_from_outranks_the_uploads_own_tags(tmp_path, monkeypatch):
    # What YouTube tagged: the single, as its first track.
    tags = {"title": "Digital Love", "artist": "Daft Punk", "album": "Digital Love (Single)", "track_number": 1}
    hint = {
        "title": "Digital Love", "artist": "Daft Punk",
        "album": "Discovery", "album_artist": "Daft Punk",
        "track_number": 3, "disc_number": 1, "year": 2001,
    }

    track, embedded = _download(tmp_path, monkeypatch, tags=tags, hint=hint)

    assert (track.album, track.album_artist) == ("Discovery", "Daft Punk")
    assert (track.track_number, track.disc_number, track.year) == (3, 1, 2001)
    # Written into the file too, so a rescan reads the same record back.
    assert embedded["album_artist"] == "Daft Punk"
    assert (embedded["track_number"], embedded["disc_number"], embedded["year"]) == (3, 1, 2001)


def test_a_download_with_no_record_keeps_what_the_upload_says(tmp_path, monkeypatch):
    tags = {"title": "Digital Love", "artist": "Daft Punk", "album": "Discovery", "track_number": 3, "year": 2001}

    track, _embedded = _download(tmp_path, monkeypatch, tags=tags, hint={"title": "Digital Love", "artist": "Daft Punk"})

    assert track.album == "Discovery"
    assert (track.track_number, track.year) == (3, 2001)


def test_positions_that_are_not_positions_are_ignored(tmp_path, monkeypatch):
    tags = {"title": "Digital Love", "artist": "Daft Punk", "album": "", "track_number": 4}
    hint = {"title": "Digital Love", "artist": "Daft Punk", "album": "Discovery", "track_number": "x", "disc_number": 0, "year": True}

    track, _embedded = _download(tmp_path, monkeypatch, tags=tags, hint=hint)

    assert track.album == "Discovery"
    assert track.track_number == 4
    assert track.disc_number is None
    assert track.year is None
