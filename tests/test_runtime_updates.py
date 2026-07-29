from pathlib import Path

import pytest

from shared.runtime_updates import enabled_runtime_packages, pip_upgrade_command


def test_enabled_runtime_packages_resolves_independent_settings():
    packages, flags = enabled_runtime_packages(
        {"YTDLP_AUTO_UPDATE": "true"},
        {"CURL_CFFI_AUTO_UPDATE": "1"},
    )

    assert packages == ["yt-dlp", "curl-cffi"]
    assert flags == {
        "YTDLP_AUTO_UPDATE": True,
        "CURL_CFFI_AUTO_UPDATE": True,
    }


def test_file_setting_takes_precedence_over_process_environment():
    packages, _ = enabled_runtime_packages(
        {"CURL_CFFI_AUTO_UPDATE": "false"},
        {"CURL_CFFI_AUTO_UPDATE": "true"},
    )

    assert "curl-cffi" not in packages


def test_pip_upgrade_command_updates_packages_in_one_transaction(tmp_path: Path):
    pip = tmp_path / ".venv" / "bin" / "pip"
    pip.parent.mkdir(parents=True)
    pip.touch()

    command = pip_upgrade_command(tmp_path, ["yt-dlp", "curl-cffi"], platform_name="posix")

    assert command == [
        str(pip),
        "install",
        "--upgrade",
        "yt-dlp",
        "curl-cffi",
    ]


def test_pip_upgrade_command_rejects_empty_package_list(tmp_path: Path):
    with pytest.raises(ValueError):
        pip_upgrade_command(tmp_path, [])
