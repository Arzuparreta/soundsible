import gzip
import json
from pathlib import Path

import pytest

from shared.runtime import RuntimeConfig, configure_runtime, reset_runtime
from shared.telemetry import (
    emit,
    init_telemetry,
    is_telemetry_enabled,
    reset_telemetry,
)


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
    for d in (runtime.config_dir, runtime.data_dir, runtime.cache_dir, runtime.log_dir):
        d.mkdir(parents=True, exist_ok=True)
    return runtime


def _count_all_lines(telemetry_dir: Path, basename: str) -> int:
    active = telemetry_dir / basename
    n = 0
    if active.exists():
        text = active.read_text(encoding="utf-8")
        n += sum(1 for line in text.splitlines() if line.strip())
    for gz_path in sorted(telemetry_dir.glob(f"{basename}.*.gz")):
        with gzip.open(gz_path, "rt", encoding="utf-8") as fh:
            n += sum(1 for line in fh if line.strip())
    return n


@pytest.fixture(autouse=True)
def _reset_runtime_and_telemetry():
    reset_runtime()
    reset_telemetry()
    yield
    reset_telemetry()
    reset_runtime()


def test_emit_1000_events_roundtrip(tmp_path, monkeypatch):
    monkeypatch.delenv("SOUNDSIBLE_TELEMETRY_MAX_FILE_BYTES", raising=False)
    runtime = _make_runtime(tmp_path)
    configure_runtime(runtime)
    init_telemetry(runtime)

    for i in range(1000):
        emit("setup-events", {"v": 1, "i": i, "event": "test"})

    reset_telemetry()

    lines = (runtime.data_dir / "telemetry" / "setup-events.jsonl").read_text(
        encoding="utf-8"
    ).strip().splitlines()
    assert len(lines) == 1000
    nums = [json.loads(line)["i"] for line in lines]
    assert nums == list(range(1000))


def test_telemetry_survives_close_and_reinit(tmp_path, monkeypatch):
    monkeypatch.delenv("SOUNDSIBLE_TELEMETRY_ENABLED", raising=False)
    runtime = _make_runtime(tmp_path)
    configure_runtime(runtime)
    init_telemetry(runtime)
    emit("play-timing", {"v": 1, "n": 1})
    emit("play-timing", {"v": 1, "n": 2})
    reset_telemetry()
    init_telemetry(runtime)
    emit("play-timing", {"v": 1, "n": 3})

    active = runtime.data_dir / "telemetry" / "play-timing.jsonl"
    lines = [json.loads(line) for line in active.read_text(encoding="utf-8").strip().splitlines()]
    assert [row["n"] for row in lines] == [1, 2, 3]


def test_unknown_category_raises(tmp_path):
    runtime = _make_runtime(tmp_path)
    configure_runtime(runtime)
    with pytest.raises(ValueError, match="Unknown telemetry category"):
        emit("listening-events", {"v": 1})


def test_telemetry_enabled_default_true(monkeypatch):
    monkeypatch.delenv("SOUNDSIBLE_TELEMETRY_ENABLED", raising=False)
    assert is_telemetry_enabled() is True


def test_rotation_no_lost_lines(tmp_path, monkeypatch):
    monkeypatch.setenv("SOUNDSIBLE_TELEMETRY_MAX_FILE_BYTES", "4096")
    # Default retention is 5 gzip segments; ~500 lines at this line size exceeds that window.
    monkeypatch.setenv("SOUNDSIBLE_TELEMETRY_MAX_ROTATIONS", "32")
    runtime = _make_runtime(tmp_path)
    configure_runtime(runtime)
    reset_telemetry()
    init_telemetry(runtime)

    for i in range(500):
        emit(
            "migration-events",
            {"v": 1, "i": i, "payload": "x" * 40},
        )

    tel_dir = runtime.data_dir / "telemetry"
    assert _count_all_lines(tel_dir, "migration-events.jsonl") == 500

    gz_count = sum(1 for _ in tel_dir.glob("migration-events.jsonl.*.gz"))
    assert gz_count >= 1


def test_opt_out_writes_nothing(tmp_path, monkeypatch):
    monkeypatch.setenv("SOUNDSIBLE_TELEMETRY_ENABLED", "0")
    runtime = _make_runtime(tmp_path)
    configure_runtime(runtime)
    init_telemetry(runtime)

    emit("setup-events", {"v": 1})

    active = runtime.data_dir / "telemetry" / "setup-events.jsonl"
    assert not active.exists()