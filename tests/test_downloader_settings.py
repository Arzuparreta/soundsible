"""The downloader's saved settings live in the configuration directory.

They used to be `odst_tool/.env` inside the checkout: a Docker container lost
them on every recreate, and the move of the code would have stranded them.
"""

import os

import pytest

from shared.downloader import settings


@pytest.fixture
def legacy(tmp_path, monkeypatch):
    path = tmp_path / "checkout" / "odst_tool" / ".env"
    path.parent.mkdir(parents=True)
    monkeypatch.setattr(settings, "_LEGACY_PATH", path)
    return path


def test_the_old_file_is_adopted_once_and_left_in_place(isolated_runtime, legacy):
    legacy.write_text("OUTPUT_DIR='/srv/music'\nYTDLP_AUTO_UPDATE='true'\n")

    assert settings.read_settings() == {"OUTPUT_DIR": "/srv/music", "YTDLP_AUTO_UPDATE": "true"}
    assert settings.settings_path() == isolated_runtime.config_dir / "downloader.env"
    assert settings.settings_path().is_file()
    assert legacy.is_file(), "a downgrade can still read the old file"

    # Once adopted, the new file is the one that counts.
    legacy.write_text("OUTPUT_DIR='/elsewhere'\n")
    settings.write_settings({"DEFAULT_QUALITY": "ultra"})
    assert settings.setting("OUTPUT_DIR") == "/srv/music"
    assert settings.setting("DEFAULT_QUALITY") == "ultra"


def test_without_any_file_there_is_nothing_to_read(isolated_runtime, legacy):
    assert settings.read_settings() == {}
    assert not settings.settings_path().exists()


def test_a_write_is_read_back_and_keeps_other_lines(isolated_runtime, legacy):
    settings.write_settings({"R2_BUCKET_NAME": "music", "DEFAULT_QUALITY": "high"})
    settings.write_settings({"DEFAULT_QUALITY": "standard"})

    assert settings.read_settings() == {"R2_BUCKET_NAME": "music", "DEFAULT_QUALITY": "standard"}


def test_exported_settings_never_override_the_real_environment(isolated_runtime, legacy, monkeypatch):
    settings.write_settings({"OUTPUT_DIR": "/from/settings", "R2_BUCKET_NAME": "music"})
    monkeypatch.setenv("OUTPUT_DIR", "/from/environment")
    # Registered with monkeypatch, so the export below is undone after the test.
    monkeypatch.setenv("R2_BUCKET_NAME", "")
    monkeypatch.delenv("R2_BUCKET_NAME")

    settings.export_to_environ()

    assert os.environ["OUTPUT_DIR"] == "/from/environment"
    assert os.environ["R2_BUCKET_NAME"] == "music"
