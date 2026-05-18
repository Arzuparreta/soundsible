from unittest.mock import MagicMock, patch

from shared.api import run_sync_task
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


def test_run_sync_task_persists_synced_library():
    stale = LibraryMetadata(version=1, tracks=[_track("stale")], playlists={}, settings={})
    synced = LibraryMetadata(version=1, tracks=[_track("remote"), _track("local")], playlists={"p": []}, settings={})

    fake_cloud = MagicMock()
    fake_cloud.is_configured.return_value = True
    fake_cloud.sync_library.return_value = {
        "uploaded": 1,
        "merged": 1,
        "total_remote": 2,
        "synced_library": synced,
    }

    fake_dl = MagicMock()
    fake_dl.cloud = fake_cloud
    fake_dl._load_library.return_value = stale
    fake_dl.library = stale

    fake_orchestrator = MagicMock()
    fake_orchestrator.submit_task.side_effect = lambda _name, fn: fn()

    with patch("shared.api.get_downloader", return_value=fake_dl):
        with patch("shared.api._sync_odst_to_main_core") as sync_core:
            with patch("shared.api.orchestrator", fake_orchestrator):
                run_sync_task()

    assert fake_dl.library == synced
    fake_dl.save_library.assert_called_once()
    sync_core.assert_called_once()
