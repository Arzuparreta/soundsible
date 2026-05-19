"""Tests for shared.ffmpeg_runtime resolution."""

from __future__ import annotations

import os
import stat
import sys
from pathlib import Path

import shared.ffmpeg_runtime as ff


def _reset_module() -> None:
    ff._RESOLVED = None
    ff._STATUS.update({"available": False, "path": None, "source": None})


def test_resolve_from_soundsible_ffmpeg_env(tmp_path, monkeypatch):
    _reset_module()
    fake = tmp_path / "ffmpeg"
    fake.write_bytes(b"")
    fake.chmod(fake.stat().st_mode | stat.S_IXUSR)
    monkeypatch.setenv("SOUNDSIBLE_FFMPEG", str(fake))
    monkeypatch.delenv("PATH", raising=False)
    assert ff.resolve_ffmpeg() == fake.resolve()
    status = ff.configure_ffmpeg()
    assert status["available"] is True
    assert status["source"] == "env"
    assert os.environ["FFMPEG_BINARY"] == str(fake.resolve())


def test_ytdlp_ffmpeg_location_uses_parent(tmp_path, monkeypatch):
    _reset_module()
    fake = tmp_path / "bin" / "ffmpeg"
    fake.parent.mkdir()
    fake.write_bytes(b"")
    fake.chmod(fake.stat().st_mode | stat.S_IXUSR)
    monkeypatch.setenv("SOUNDSIBLE_FFMPEG", str(fake))
    assert ff.ytdlp_ffmpeg_location() == str(fake.parent)
    opts: dict = {}
    ff.apply_ytdlp_ffmpeg_options(opts)
    assert opts["ffmpeg_location"] == str(fake.parent)
