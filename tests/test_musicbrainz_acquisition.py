from pathlib import Path

from odst_tool.youtube_downloader import YouTubeDownloader
from shared.musicbrainz import normalize_recording_mbid


RECORDING_MBID = "b1a9c0e9-d987-4042-ae91-78d6a3267d69"


def test_recording_mbid_normalization_is_strict_and_canonical():
    assert normalize_recording_mbid(RECORDING_MBID.upper()) == RECORDING_MBID
    assert normalize_recording_mbid(f"{{{RECORDING_MBID}}}") is None
    assert normalize_recording_mbid(RECORDING_MBID.replace("-", "")) is None
    assert normalize_recording_mbid("not-an-mbid") is None


def test_video_acquisition_embeds_and_preserves_the_recording_mbid(tmp_path, monkeypatch):
    downloader = YouTubeDownloader(output_dir=tmp_path)
    temporary = tmp_path / "temp" / "download.mp3"
    temporary.write_bytes(b"audio")
    embedded = []

    monkeypatch.setattr(downloader, "_download_audio", lambda *_args, **_kwargs: temporary)
    monkeypatch.setattr(
        "odst_tool.youtube_downloader.AudioProcessor.get_audio_details",
        lambda _path: (180, 320, 5),
    )
    monkeypatch.setattr(
        "odst_tool.youtube_downloader.AudioProcessor.get_metadata_from_file",
        lambda _path: {"title": "", "artist": "", "album": ""},
    )
    monkeypatch.setattr(
        "odst_tool.youtube_downloader.AudioProcessor.embed_metadata",
        lambda _path, metadata, _cover: embedded.append(dict(metadata)),
    )
    monkeypatch.setattr(
        "odst_tool.youtube_downloader.AudioProcessor.calculate_hash",
        lambda _path: "content-hash",
    )

    track = downloader.process_video(
        "https://www.youtube.com/watch?v=abcdefghijk",
        metadata_hint={
            "title": "Bohemian Rhapsody",
            "artist": "Queen",
            "musicbrainz_id": RECORDING_MBID.upper(),
        },
    )

    assert track is not None
    assert track.musicbrainz_id == RECORDING_MBID
    assert track.youtube_id == "abcdefghijk"
    assert embedded[0]["musicbrainz_id"] == RECORDING_MBID
    assert Path(tmp_path / "tracks" / "content-hash.mp3").is_file()
