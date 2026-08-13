from pathlib import Path

import odst_tool.audio_utils as odst_audio
import setup_tool.audio as setup_audio
from shared.musicbrainz import (
    MUSICBRAINZ_MP4_RECORDING_TAG,
    MUSICBRAINZ_UFID_OWNER,
    MUSICBRAINZ_VORBIS_RECORDING_TAG,
)


RECORDING_MBID = "b1a9c0e9-d987-4042-ae91-78d6a3267d69"


class _Info:
    length = 180
    bitrate = 320_000


class _Frame:
    def __init__(self, *values):
        self.text = list(values)

    def __str__(self):
        return str(self.text[0]) if self.text else ""


class _FakeMP3:
    def __init__(self):
        self.info = _Info()
        self.tags = {
            "TIT2": _Frame("A Song"),
            "TPE1": _Frame("First Artist", "Second Artist"),
            "TALB": _Frame("Collection"),
            "TPE2": _Frame("Various Artists"),
            "TRCK": _Frame("4/12"),
            "TPOS": _Frame("2/3"),
            "TCMP": _Frame("1"),
            f"UFID:{MUSICBRAINZ_UFID_OWNER}": type(
                "RecordingUfid", (), {"data": RECORDING_MBID.encode("ascii")}
            )(),
        }


def test_scanner_reads_structured_mp3_credits_and_disc_tags(monkeypatch):
    monkeypatch.setattr(setup_audio, "MP3", _FakeMP3)
    monkeypatch.setattr(setup_audio, "MutagenFile", lambda _path, easy=False: _FakeMP3())

    metadata = setup_audio.AudioProcessor.extract_metadata("song.mp3")

    assert metadata["artist"] == "First Artist & Second Artist"
    assert metadata["artists"] == ["First Artist", "Second Artist"]
    assert metadata["disc_number"] == 2
    assert metadata["disc_total"] == 3
    assert metadata["is_compilation"] is True
    assert metadata["musicbrainz_id"] == RECORDING_MBID


class _WritableTags:
    def __init__(self):
        self.frames = []

    def add(self, frame):
        self.frames.append(frame)


class _WritableMP3:
    def __init__(self):
        self.tags = _WritableTags()
        self.saved = False

    def save(self):
        self.saved = True


def test_downloader_embeds_multiple_artists_and_disc_tags(monkeypatch, tmp_path):
    audio = _WritableMP3()
    monkeypatch.setattr(odst_audio, "MP3", lambda *args, **kwargs: audio)

    odst_audio.AudioProcessor._embed_mp3(
        str(Path(tmp_path) / "song.mp3"),
        {
            "title": "A Song",
            "artist": "First Artist & Second Artist",
            "artists": ["First Artist", "Second Artist"],
            "album": "Collection",
            "disc_number": 2,
            "disc_total": 3,
            "is_compilation": True,
            "musicbrainz_id": RECORDING_MBID,
        },
        None,
    )

    by_name = {type(frame).__name__: frame for frame in audio.tags.frames}
    assert by_name["TPE1"].text == ["First Artist", "Second Artist"]
    assert by_name["TPOS"].text == ["2/3"]
    assert by_name["TCMP"].text == ["1"]
    assert by_name["UFID"].owner == MUSICBRAINZ_UFID_OWNER
    assert by_name["UFID"].data == RECORDING_MBID.encode("ascii")
    assert audio.saved is True


class _WritableFLAC(dict):
    def __init__(self):
        super().__init__()
        self.saved = False

    def add_picture(self, _picture):
        raise AssertionError("no cover should be added")

    def save(self):
        self.saved = True


def test_downloader_embeds_recording_mbid_in_flac(monkeypatch, tmp_path):
    audio = _WritableFLAC()
    monkeypatch.setattr(odst_audio, "FLAC", lambda _path: audio)

    odst_audio.AudioProcessor._embed_flac(
        str(tmp_path / "song.flac"),
        {"title": "A Song", "musicbrainz_id": RECORDING_MBID.upper()},
        None,
    )

    assert audio[MUSICBRAINZ_VORBIS_RECORDING_TAG] == RECORDING_MBID
    assert audio.saved is True


class _FakeOgg:
    def __init__(self):
        self.info = _Info()
        self.tags = {
            "title": ["A Song"],
            "artist": ["An Artist"],
            "album": ["An Album"],
            MUSICBRAINZ_VORBIS_RECORDING_TAG: [RECORDING_MBID],
        }


class _FakeFLAC(_FakeOgg):
    pictures = []


class _FakeMP4:
    def __init__(self):
        self.info = _Info()
        self.tags = {
            "\xa9nam": ["A Song"],
            "\xa9ART": ["An Artist"],
            "\xa9alb": ["An Album"],
            MUSICBRAINZ_MP4_RECORDING_TAG: [RECORDING_MBID.encode("ascii")],
        }


def test_scanner_reads_recording_mbid_from_flac_vorbis_and_mp4(monkeypatch):
    flac = _FakeFLAC()
    monkeypatch.setattr(setup_audio, "FLAC", _FakeFLAC)
    monkeypatch.setattr(setup_audio, "MutagenFile", lambda _path, easy=False: flac)
    assert setup_audio.AudioProcessor.extract_metadata("song.flac")["musicbrainz_id"] == RECORDING_MBID

    ogg = _FakeOgg()
    monkeypatch.setattr(setup_audio, "OggVorbis", _FakeOgg)
    monkeypatch.setattr(setup_audio, "MutagenFile", lambda _path, easy=False: ogg)
    assert setup_audio.AudioProcessor.extract_metadata("song.ogg")["musicbrainz_id"] == RECORDING_MBID

    mp4 = _FakeMP4()
    monkeypatch.setattr(setup_audio, "MP4", _FakeMP4)
    monkeypatch.setattr(setup_audio, "MutagenFile", lambda _path, easy=False: mp4)
    assert setup_audio.AudioProcessor.extract_metadata("song.m4a")["musicbrainz_id"] == RECORDING_MBID
