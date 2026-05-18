from pathlib import Path

from odst_tool.cloud_sync import CloudSync
from shared.models import LibraryMetadata, Track


def _track(suffix: str) -> Track:
    return Track(
        id=f"id-{suffix}",
        title=f"Song {suffix}",
        artist="Artist",
        album="Album",
        duration=120,
        file_hash=f"hash-{suffix}",
        original_filename=f"{suffix}.mp3",
        compressed=False,
        file_size=1234,
        bitrate=320,
        format="mp3",
    )


class _FakeBody:
    def __init__(self, text: str):
        self._text = text

    def read(self):
        return self._text.encode("utf-8")


class _FakeS3:
    def __init__(self, remote_library: LibraryMetadata):
        self._remote_library = remote_library
        self.put_payload = None

    def get_object(self, Bucket, Key):  # noqa: N803
        return {"Body": _FakeBody(self._remote_library.to_json())}

    def head_object(self, Bucket, Key):  # noqa: N803
        return {"ok": True}

    def put_object(self, Bucket, Key, Body, ContentType):  # noqa: N803
        self.put_payload = Body


def test_sync_library_returns_synced_library(tmp_path):
    remote = LibraryMetadata(version=1, tracks=[_track("remote")], playlists={"r": []}, settings={})
    local = LibraryMetadata(version=1, tracks=[_track("local")], playlists={}, settings={})

    sync = CloudSync(Path(tmp_path))
    sync.config = {"bucket": "test"}
    sync.s3_client = _FakeS3(remote)
    sync.upload_file = lambda *_args, **_kwargs: True

    result = sync.sync_library(local)

    assert "error" not in result
    assert result["total_remote"] == 2
    assert isinstance(result["synced_library"], LibraryMetadata)
    assert {t.id for t in result["synced_library"].tracks} == {"id-remote", "id-local"}
