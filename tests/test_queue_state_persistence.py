from pathlib import Path

from player.queue_manager import QueueManager
from shared.models import QueueItem, Track
from shared.runtime import RuntimeConfig, configure_runtime, reset_runtime


def _make_runtime(tmp_path: Path) -> RuntimeConfig:
    runtime = RuntimeConfig(
        host="127.0.0.1",
        port=5005,
        config_dir=(tmp_path / "cfg").resolve(),
        data_dir=(tmp_path / "data").resolve(),
        cache_dir=(tmp_path / "cache").resolve(),
        log_dir=(tmp_path / "logs").resolve(),
        music_dir=(tmp_path / "music").resolve(),
        ui_dist=None,
        owner_token_file=None,
        lan_enabled=False,
        advanced_mode=False,
    )
    for d in (runtime.config_dir, runtime.data_dir, runtime.cache_dir, runtime.log_dir, runtime.music_dir):
        d.mkdir(parents=True, exist_ok=True)
    return runtime


def _sample_track(i: int) -> Track:
    return Track(
        id=f"t{i}",
        title=f"Title {i}",
        artist="Artist",
        album="Album",
        duration=120,
        file_hash="hash",
        original_filename=f"{i}.mp3",
        compressed=False,
        file_size=1000,
        bitrate=320,
        format="mp3",
    )


def test_queue_manager_persist_restore_roundtrip(tmp_path):
    reset_runtime()
    runtime = _make_runtime(tmp_path)
    configure_runtime(runtime)
    state_path = runtime.data_dir / "queue_state.json"

    q1 = QueueManager(persist_path=state_path)
    for i in range(5):
        q1.add(_sample_track(i))
    q1.set_repeat_mode("all")

    q2 = QueueManager(persist_path=state_path)
    assert q2.size() == 5
    assert q2.get_repeat_mode() == "all"
    assert [item.id for item in q2.get_all()] == [f"t{i}" for i in range(5)]


def test_queue_item_from_dict_roundtrip():
    item = QueueItem.from_preview(
        video_id="vid",
        title="T",
        artist="A",
        duration=90,
        thumbnail="http://example.com/t.jpg",
        album="Al",
    )
    restored = QueueItem.from_dict(item.to_dict())
    assert restored == item
