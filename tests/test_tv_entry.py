"""Tests for Smart TV entrypoint routing, cache headers, dist freshness, and form factor."""

from __future__ import annotations

import os
from pathlib import Path

from flask import Flask

import shared.api as api_mod
from shared.ensure_ui_dist import ensure_ui_dist, ui_dist_is_stale
from shared.playback_state import register_device
from shared.runtime import RuntimeConfig, configure_runtime, reset_runtime


def _touch(path: Path, content: str = "x", *, mtime: float) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    os.utime(path, (mtime, mtime))


def _configure(tmp_path, *, ui_dist: Path | None = None):
    runtime = RuntimeConfig(
        host="127.0.0.1",
        port=5005,
        config_dir=(tmp_path / "cfg").resolve(),
        data_dir=(tmp_path / "data").resolve(),
        cache_dir=(tmp_path / "cache").resolve(),
        log_dir=(tmp_path / "logs").resolve(),
        music_dir=(tmp_path / "music").resolve(),
        ui_dist=ui_dist,
        owner_token_file=None,
        lan_enabled=False,
        advanced_mode=False,
    )
    for path in (runtime.config_dir, runtime.data_dir, runtime.cache_dir, runtime.log_dir, runtime.music_dir):
        path.mkdir(parents=True, exist_ok=True)
    configure_runtime(runtime)
    return runtime


def test_ensure_ui_dist_requires_tv_html_when_present(tmp_path: Path):
    ui_web = tmp_path / "ui_web"
    _touch(ui_web / "index.html", mtime=100)
    _touch(ui_web / "tv.html", mtime=100)
    _touch(ui_web / "dist" / "index.html", mtime=200)
    # dist/tv.html is absent even though dist/index.html is newer -> stale!
    assert ui_dist_is_stale(ui_web) is True

    _touch(ui_web / "dist" / "tv.html", mtime=200)
    assert ui_dist_is_stale(ui_web) is False

    # Touching ui_web/tv.html makes dist stale until rebuilt.
    _touch(ui_web / "tv.html", content="updated", mtime=300)
    assert ui_dist_is_stale(ui_web) is True


def test_ensure_ui_dist_respects_skip_env_requiring_tv_html(tmp_path: Path, monkeypatch):
    ui_web = tmp_path / "ui_web"
    _touch(ui_web / "tv.html", mtime=100)
    _touch(ui_web / "dist" / "index.html", mtime=100)
    monkeypatch.setenv("SOUNDSIBLE_SKIP_UI_BUILD", "1")
    assert ensure_ui_dist(ui_web=ui_web) is False

    _touch(ui_web / "dist" / "tv.html", mtime=100)
    assert ensure_ui_dist(ui_web=ui_web) is True


def test_tv_entry_redirect_serving_and_missing_dist_fallback(tmp_path: Path, monkeypatch):
    reset_runtime()
    dist_complete = (tmp_path / "dist_ok").resolve()
    _touch(dist_complete / "index.html", "<html>player</html>", mtime=100)
    _touch(dist_complete / "tv.html", "<html>tv</html>", mtime=100)
    _configure(tmp_path, ui_dist=dist_complete)
    monkeypatch.setenv("SOUNDSIBLE_SKIP_UI_BUILD", "1")

    client = api_mod.app.test_client()

    redir = client.get("/tv")
    assert redir.status_code == 308
    assert redir.headers["Location"].endswith("/tv/")

    page = client.get("/tv/")
    assert page.status_code == 200
    assert "no-store" in page.headers.get("Cache-Control", "")
    assert "<html>tv</html>" in page.get_data(as_text=True)

    # Simulate an older external dist that lacks dist/tv.html -> clear 503 no-store fallback.
    dist_old = (tmp_path / "dist_old").resolve()
    _touch(dist_old / "index.html", "<html>player</html>", mtime=100)
    _configure(tmp_path, ui_dist=dist_old)

    unavailable = client.get("/tv/")
    assert unavailable.status_code == 503
    assert "no-store" in unavailable.headers.get("Cache-Control", "")
    assert "Soundsible TV is unavailable" in unavailable.get_data(as_text=True)


def test_playback_state_accepts_tv_form_factor(tmp_path: Path):
    reset_runtime()
    _configure(tmp_path)
    row = register_device(
        "tv_scope",
        device_id="tv-living",
        device_name="LG OLED",
        device_type="web",
        form_factor="tv",
    )
    assert row["form_factor"] == "tv"
    assert row["device_type"] == "web"
