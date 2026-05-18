"""Phase 2: queue revision monotonicity and core mutation behaviors."""

from pathlib import Path

from player.queue_manager import QueueManager
from shared.models import Track


def _track(i: int) -> Track:
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


def test_queue_revision_increments_on_mutations(tmp_path: Path) -> None:
    q = QueueManager(persist_path=tmp_path / "q.json")
    assert q.get_revision() == 0
    q.add(_track(0))
    assert q.get_revision() == 1
    q.add(_track(1))
    assert q.get_revision() == 2
    assert q.remove(0) is True
    assert q.get_revision() == 3
    q.move(0, 0)
    assert q.get_revision() == 4
    q.shuffle()
    assert q.get_revision() == 5
    q.clear()
    assert q.get_revision() == 6
    assert q.size() == 0


def test_queue_peek_does_not_bump_revision(tmp_path: Path) -> None:
    q = QueueManager(persist_path=tmp_path / "q.json")
    q.add(_track(0))
    rev = q.get_revision()
    assert q.peek() is not None
    assert q.get_revision() == rev


def test_get_next_and_consume_head_bump_revision(tmp_path: Path) -> None:
    q = QueueManager(persist_path=tmp_path / "q.json")
    q.add(_track(0))
    q.add(_track(1))
    r0 = q.get_revision()
    head = q.peek()
    assert head is not None
    item = q.get_next()
    assert item is not None
    assert q.get_revision() == r0 + 1
    r1 = q.get_revision()
    consumed = q.consume_head_if_id(q.peek().id) if q.peek() else None
    assert consumed is not None
    assert q.get_revision() == r1 + 1


def test_remove_by_id_bumps_revision(tmp_path: Path) -> None:
    q = QueueManager(persist_path=tmp_path / "q.json")
    q.add(_track(0))
    q.add(_track(1))
    r = q.get_revision()
    assert q.remove_by_id("t0") == 1
    assert q.get_revision() == r + 1
    assert [x.id for x in q.get_all()] == ["t1"]


def test_add_multiple_single_notify(tmp_path: Path) -> None:
    q = QueueManager(persist_path=tmp_path / "q.json")
    q.add_multiple([_track(0), _track(1), _track(2)])
    assert q.size() == 3
    assert q.get_revision() == 1
