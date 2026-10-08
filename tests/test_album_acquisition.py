"""A song downloaded from an album page lands on that album, in its place."""

from shared.downloader.youtube_downloader import YouTubeDownloader


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
        lambda _path, metadata, _cover, clear=(): embedded.append(dict(metadata, _cleared=sorted(clear))),
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
    tags = {"title": "Digital Love", "artist": "Daft Punk", "album": "Discovery", "track_number": 4}
    hint = {"title": "Digital Love", "artist": "Daft Punk", "album": "Discovery", "track_number": "x", "disc_number": 0, "year": True}

    track, _embedded = _download(tmp_path, monkeypatch, tags=tags, hint=hint)

    assert track.album == "Discovery"
    assert track.track_number == 4
    assert track.disc_number is None
    assert track.year is None


def test_a_record_named_alone_does_not_inherit_the_uploads_place(tmp_path, monkeypatch):
    # A plain search row names the album and nothing else.
    tags = {"title": "Digital Love", "artist": "Daft Punk", "album": "Digital Love (Single)",
            "album_artist": "Daft Punk Official", "track_number": 2, "disc_number": 1, "disc_total": 3, "year": 2014}

    track, embedded = _download(tmp_path, monkeypatch, tags=tags, hint={"title": "Digital Love", "artist": "Daft Punk", "album": "Discovery"})

    assert track.album == "Discovery"
    assert (track.album_artist, track.disc_number, track.year) == (None, None, None)
    assert track.track_number == 1
    assert not {"album_artist", "disc_number", "disc_total", "year"} & {key for key, value in embedded.items() if value and key != "_cleared"}
    # ...and the file loses the upload's tags for them.
    assert embedded["_cleared"] == ["album_artist", "disc_number", "year"]


def test_another_record_is_not_a_compilation_because_the_upload_was(tmp_path, monkeypatch):
    tags = {"title": "Digital Love", "artist": "Daft Punk", "album": "Hits 2001", "is_compilation": True}

    track, embedded = _download(tmp_path, monkeypatch, tags=tags, hint={"title": "Digital Love", "artist": "Daft Punk", "album": "Discovery"})

    assert track.album == "Discovery"
    assert embedded["is_compilation"] is False
    assert "is_compilation" in embedded["_cleared"]


def test_an_import_with_no_album_keeps_the_uploads_place(tmp_path, monkeypatch):
    # A playlist import names no album: nothing says the upload's record is wrong.
    tags = {"title": "Digital Love", "artist": "Daft Punk", "album": "Discovery", "track_number": 3, "year": 2001}

    track, _embedded = _download(tmp_path, monkeypatch, tags=tags, hint={"title": "Digital Love", "artist": "Daft Punk", "album": ""})

    assert (track.track_number, track.year) == (3, 2001)
