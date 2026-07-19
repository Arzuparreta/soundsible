"""Tests for ui_web/dist staleness detection and skip paths."""

from __future__ import annotations

import os
from pathlib import Path

import shared.ensure_ui_dist as ensure_mod
from shared.ensure_ui_dist import ensure_ui_dist, ui_dist_is_stale


def _touch(path: Path, *, mtime: float) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("x", encoding="utf-8")
    os.utime(path, (mtime, mtime))


def test_ui_dist_is_stale_when_missing(tmp_path: Path):
    ui_web = tmp_path / "ui_web"
    (ui_web / "src").mkdir(parents=True)
    assert ui_dist_is_stale(ui_web) is True


def test_ui_dist_is_stale_when_source_newer(tmp_path: Path):
    ui_web = tmp_path / "ui_web"
    _touch(ui_web / "dist" / "index.html", mtime=100)
    _touch(ui_web / "src" / "App.tsx", mtime=200)
    assert ui_dist_is_stale(ui_web) is True


def test_ui_dist_is_current_when_dist_newer(tmp_path: Path):
    ui_web = tmp_path / "ui_web"
    _touch(ui_web / "src" / "App.tsx", mtime=100)
    _touch(ui_web / "dist" / "index.html", mtime=200)
    assert ui_dist_is_stale(ui_web) is False


def test_ensure_skips_when_external_dist_set(tmp_path: Path, monkeypatch):
    ui_web = tmp_path / "ui_web"
    _touch(ui_web / "dist" / "index.html", mtime=100)
    _touch(ui_web / "src" / "App.tsx", mtime=200)

    def fail_run(*_a, **_k):
        raise AssertionError("vite build should not run for external ui_dist")

    monkeypatch.setattr(ensure_mod.subprocess, "run", fail_run)
    assert ensure_ui_dist(ui_web=ui_web, external_dist=tmp_path / "bundled") is True


def test_ensure_skips_when_env_set(tmp_path: Path, monkeypatch):
    ui_web = tmp_path / "ui_web"
    _touch(ui_web / "dist" / "index.html", mtime=100)
    _touch(ui_web / "src" / "App.tsx", mtime=200)
    monkeypatch.setenv("SOUNDSIBLE_SKIP_UI_BUILD", "1")

    def fail_run(*_a, **_k):
        raise AssertionError("vite build should not run when skip env is set")

    monkeypatch.setattr(ensure_mod.subprocess, "run", fail_run)
    assert ensure_ui_dist(ui_web=ui_web) is True
