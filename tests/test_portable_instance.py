import json
from pathlib import Path

import pytest

from player.favourites_manager import FavouritesManager
from player.library import LibraryManager
from player.queue_manager import QueueManager
from shared.database import instance_db, user_db
from shared.instance_layout import (
    InstanceError,
    InstanceLayout,
    InstanceLock,
    backup_database,
    create_instance,
    inspect_instance,
)
from shared.models import LibraryMetadata, Track
from shared.multiuser_migration import ensure_multiuser_layout
from shared.portable_migration import migrate_legacy_instance
from shared.runtime import RuntimeConfig, configure_runtime
from shared.user_context import user_config_dir, user_context, user_data_dir
from shared.users import ROLE_ADMIN, create_user, delete_user


def _track(track_id: str) -> Track:
    return Track(
        id=track_id,
        title=f"Song {track_id}",
        artist="Artist",
        album="Album",
        duration=120,
        file_hash=track_id,
        original_filename=f"{track_id}.mp3",
        compressed=False,
        file_size=3,
        bitrate=320,
        format="mp3",
        is_local=True,
    )


def _use_instance(root: Path) -> RuntimeConfig:
    runtime = RuntimeConfig.default({"SOUNDSIBLE_INSTANCE_DIR": str(root)})
    configure_runtime(runtime)
    return runtime


def test_create_instance_has_one_self_contained_layout(tmp_path):
    layout = create_instance(tmp_path / "My Soundsible")

    assert layout.marker.is_file()
    assert layout.media_dir.is_dir()
    assert layout.tracks_dir.is_dir()
    assert (layout.root / "config.json").is_file()
    assert json.loads(layout.marker.read_text())["instance_id"] == layout.instance_id


def test_portable_first_account_is_created_without_user_directories(tmp_path):
    layout = create_instance(tmp_path / "portable")
    _use_instance(layout.root)

    report = ensure_multiuser_layout()

    assert report is not None
    assert report["username"] == "owner"
    assert instance_db().count_users(include_disabled=True) == 1
    assert not (layout.root / "users").exists()


def test_instance_rejects_nonempty_unmarked_directory(tmp_path):
    target = tmp_path / "not-an-instance"
    target.mkdir()
    (target / "unrelated.txt").write_text("keep me")

    with pytest.raises(InstanceError):
        create_instance(target)


def test_one_database_keeps_user_state_isolated(tmp_path):
    layout = create_instance(tmp_path / "portable")
    _use_instance(layout.root)
    instance_db()
    ana = create_user("ana", role=ROLE_ADMIN)
    bob = create_user("bob")

    with user_context(ana["id"]):
        library = LibraryManager(silent=True)
        library.metadata = LibraryMetadata(
            version=1,
            tracks=[_track("ana-track")],
            playlists={"Ana Mix": ["ana-track"]},
            settings={},
        )
        assert library._save_metadata()
        FavouritesManager().add("ana-track")
        QueueManager().add_library_track(_track("ana-track"))

    with user_context(bob["id"]):
        library = LibraryManager(silent=True)
        library.metadata = LibraryMetadata(
            version=1,
            tracks=[_track("bob-track")],
            playlists={},
            settings={},
        )
        assert library._save_metadata()
        assert FavouritesManager().get_all() == []
        assert QueueManager().get_all() == []

    with user_context(ana["id"]):
        assert [track.id for track in user_db().get_all_tracks()] == ["ana-track"]
        assert FavouritesManager().get_all() == ["ana-track"]
        assert [item.id for item in QueueManager().get_all()] == ["ana-track"]
    with user_context(bob["id"]):
        assert [track.id for track in user_db().get_all_tracks()] == ["bob-track"]
        assert [track.id for track in user_db().search_tracks("Song bob")] == [
            "bob-track"
        ]

    assert layout.database.is_file()
    assert not (layout.root / "users").exists()
    assert delete_user(bob["id"])
    with instance_db()._get_connection() as conn:
        assert conn.execute(
            "SELECT COUNT(*) FROM user_tracks_fts WHERE user_id = ?",
            (bob["id"],),
        ).fetchone()[0] == 0


def test_instance_survives_directory_move_without_path_repair(tmp_path):
    original = create_instance(tmp_path / "before")
    _use_instance(original.root)
    instance_db()
    user = create_user("owner", role=ROLE_ADMIN)
    with user_context(user["id"]):
        library = LibraryManager(silent=True)
        movable = _track("movable")
        movable.local_path = str(original.tracks_dir / "movable.mp3")
        library.metadata = LibraryMetadata(
            version=3,
            tracks=[movable],
            playlists={},
            settings={},
        )
        library._save_metadata()
    old_root_bytes = str(original.root).encode()
    for path in original.root.rglob("*"):
        if path.is_file() and path.name != "instance.lock":
            assert old_root_bytes not in path.read_bytes()
    moved_root = tmp_path / "after"
    original.root.rename(moved_root)

    runtime = _use_instance(moved_root)
    with user_context(user["id"]):
        restored = LibraryManager(silent=True)
        assert restored.sync_library()
        assert [track.id for track in restored.metadata.tracks] == ["movable"]
    assert runtime.music_dir == moved_root / "media"


def test_lock_backup_and_doctor(tmp_path):
    layout = create_instance(tmp_path / "portable")
    _use_instance(layout.root)
    instance_db()
    lock = InstanceLock(layout)
    lock.acquire()
    with pytest.raises(InstanceError):
        InstanceLock(layout).acquire()
    lock.release()

    backup = backup_database(layout.root)
    report = inspect_instance(layout.root)
    assert backup.is_file()
    assert report["ok"] is True
    assert report["integrity_check"] == "ok"
    assert report["schema_version"] == 1


def test_machine_secrets_never_enter_portable_directory(tmp_path, monkeypatch):
    layout = create_instance(tmp_path / "portable")
    _use_instance(layout.root)
    secret_file = tmp_path / "machine-config" / "secrets.json"
    monkeypatch.setattr(
        "shared.config_store._secret_path",
        lambda _instance_id: secret_file,
    )
    from shared.config_store import (
        load_portable_downloader_config,
        save_portable_downloader_config,
    )

    save_portable_downloader_config(
        {
            "quality": "lossless",
            "r2_access_key": "portable-must-not-contain-this",
            "r2_secret_key": "nor-this-secret",
        }
    )

    loaded = load_portable_downloader_config()
    assert loaded["quality"] == "lossless"
    assert loaded["output_dir"] == str(layout.media_dir)
    assert loaded["r2_access_key"] == "portable-must-not-contain-this"
    capsule_bytes = b"".join(
        path.read_bytes()
        for path in layout.root.rglob("*")
        if path.is_file()
    )
    assert b"portable-must-not-contain-this" not in capsule_bytes
    assert b"nor-this-secret" not in capsule_bytes
    assert secret_file.is_file()


def test_legacy_multiuser_migration_is_non_destructive(tmp_path):
    legacy_config = tmp_path / "legacy-config"
    legacy_data = tmp_path / "legacy-data"
    legacy_music = tmp_path / "legacy-music"
    runtime = RuntimeConfig(
        host="127.0.0.1",
        port=5005,
        config_dir=legacy_config,
        data_dir=legacy_data,
        cache_dir=tmp_path / "legacy-cache",
        log_dir=tmp_path / "legacy-logs",
        music_dir=legacy_music,
        ui_dist=None,
        owner_token_file=None,
        lan_enabled=False,
        advanced_mode=True,
    )
    configure_runtime(runtime)
    for path in (
        legacy_config,
        legacy_data,
        runtime.cache_dir,
        runtime.log_dir,
        legacy_music / "tracks",
    ):
        path.mkdir(parents=True, exist_ok=True)
    instance_db()
    user = create_user("ana", role=ROLE_ADMIN)
    metadata = LibraryMetadata(
        version=4,
        tracks=[_track("legacy-track")],
        playlists={"Legacy": ["legacy-track"]},
        settings={},
    )
    with user_context(user["id"]):
        user_config_dir().joinpath("library.json").write_text(metadata.to_json())
        user_config_dir().joinpath("favourites.json").write_text(
            json.dumps({"version": "1.0", "favourites": ["legacy-track"]})
        )
        user_data_dir().joinpath("queue_state.json").write_text(
            json.dumps({"version": 1, "repeat_mode": "off", "queue": []})
        )
        user_db().sync_from_metadata(metadata)
    (legacy_music / "tracks" / "legacy-track.mp3").write_bytes(b"abc")
    (legacy_music / "library.json").write_text(metadata.to_json())
    (legacy_config / "config.json").write_text(
        json.dumps(
            {
                "provider": "local",
                "endpoint": str(legacy_music),
                "bucket": "",
                "access_key_id": "",
                "secret_access_key": "",
                "is_encrypted": False,
            }
        )
    )

    target = tmp_path / "migrated"
    report = migrate_legacy_instance(
        target,
        legacy_config_dir=legacy_config,
        legacy_data_dir=legacy_data,
        legacy_music_dir=legacy_music,
    )

    assert report["integrity_check"] == "ok"
    assert report["users"][user["id"]]["tracks"] == 1
    assert (legacy_music / "tracks" / "legacy-track.mp3").is_file()
    assert (target / "media" / "tracks" / "legacy-track.mp3").is_file()
    legacy_roots = (
        str(legacy_config).encode(),
        str(legacy_data).encode(),
        str(legacy_music).encode(),
    )
    for path in target.rglob("*"):
        if path.is_file():
            contents = path.read_bytes()
            assert all(root not in contents for root in legacy_roots)
    _use_instance(target)
    with user_context(user["id"]):
        assert [track.id for track in user_db().get_all_tracks()] == ["legacy-track"]
        assert FavouritesManager().get_all() == ["legacy-track"]
