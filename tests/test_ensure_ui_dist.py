"""Tests for ui_web/dist staleness detection and skip paths."""

from __future__ import annotations

import os

import pytest
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


def test_public_worker_and_branding_invalidate_the_bundle(tmp_path: Path):
    ui_web = tmp_path / "ui_web"
    _touch(ui_web / "dist" / "index.html", mtime=200)
    _touch(ui_web / "public" / "sw.js", mtime=300)
    assert ui_dist_is_stale(ui_web)

    _touch(ui_web / "public" / "sw.js", mtime=100)
    _touch(tmp_path / "branding" / "logo-mark.svg", mtime=300)
    assert ui_dist_is_stale(ui_web)


def built_tree(tmp_path, monkeypatch, during_build=None):
    from types import SimpleNamespace
    ui_web = tmp_path / 'ui_web'
    _touch(ui_web / 'src' / 'App.tsx', mtime=100)
    (ui_web / 'node_modules').mkdir()
    monkeypatch.setattr(ensure_mod.shutil, 'which', lambda _: 'npm')

    def build(*args, **kwargs):
        _touch(ui_web / 'dist' / 'index.html', mtime=200)
        if during_build:
            during_build(ui_web)
        return SimpleNamespace(returncode=0)

    monkeypatch.setattr(ensure_mod.subprocess, 'run', build)
    assert ensure_ui_dist(ui_web=ui_web)
    return ui_web


@pytest.mark.parametrize('mutation', ['delete', 'rename', 'add_old_file', 'same_mtime_size', 'public_delete'])
def test_input_manifest_observes_changes_that_mtime_only_misses(tmp_path, monkeypatch, mutation):
    ui_web = built_tree(tmp_path, monkeypatch)
    source = ui_web / 'src' / 'App.tsx'
    assert not ui_dist_is_stale(ui_web)
    if mutation == 'delete':
        source.unlink()
    elif mutation == 'rename':
        source.rename(source.with_name('Renamed.tsx'))
    elif mutation == 'add_old_file':
        _touch(ui_web / 'src' / 'Restored.tsx', mtime=50)
    elif mutation == 'same_mtime_size':
        source.write_text('different length')
        os.utime(source, (100, 100))
    else:
        _touch(ui_web / 'public' / 'sw.js', mtime=50)
        assert ensure_ui_dist(ui_web=ui_web)
        (ui_web / 'public' / 'sw.js').unlink()
    assert ui_dist_is_stale(ui_web)


def test_edit_during_build_is_not_certified_as_current(tmp_path, monkeypatch):
    ui_web = built_tree(tmp_path, monkeypatch,
                        during_build=lambda root: _touch(root / 'src' / 'App.tsx', mtime=150))
    assert ui_dist_is_stale(ui_web)


def test_failed_build_does_not_update_input_manifest(tmp_path, monkeypatch):
    from types import SimpleNamespace
    ui_web = built_tree(tmp_path, monkeypatch)
    _touch(ui_web / 'src' / 'App.tsx', mtime=300)
    monkeypatch.setattr(ensure_mod.subprocess, 'run', lambda *a, **k: SimpleNamespace(returncode=1, stderr='failed'))
    assert ensure_ui_dist(ui_web=ui_web)
    assert ui_dist_is_stale(ui_web)
