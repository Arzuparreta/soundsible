import subprocess
import sys
from pathlib import Path

import pytest

from shared.runtime_updates import apply_runtime_updates, enabled_runtime_packages, pip_upgrade_command


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


def _pip_ok(calls):
    def run(command, **kwargs):
        calls.append(command)
        return subprocess.CompletedProcess(command, 0, "", "")
    return run


def test_the_update_runs_to_completion_before_the_tools_are_imported(monkeypatch):
    calls = []
    monkeypatch.setattr(subprocess, "run", _pip_ok(calls))
    monkeypatch.delitem(sys.modules, "yt_dlp", raising=False)

    assert apply_runtime_updates({"YTDLP_AUTO_UPDATE": "true"}) is True
    assert calls and calls[0][-1] == "yt-dlp"


def test_an_already_imported_tool_is_never_replaced_under_itself(monkeypatch):
    calls = []
    monkeypatch.setattr(subprocess, "run", _pip_ok(calls))
    monkeypatch.setitem(sys.modules, "yt_dlp", object())

    assert apply_runtime_updates({"YTDLP_AUTO_UPDATE": "true"}) is False
    assert calls == []


def test_a_packaged_build_has_no_pip_to_run(monkeypatch):
    calls = []
    monkeypatch.setattr(subprocess, "run", _pip_ok(calls))
    monkeypatch.setattr(sys, "frozen", True, raising=False)

    assert apply_runtime_updates({"YTDLP_AUTO_UPDATE": "true"}) is False
    assert calls == []


def test_nothing_runs_when_no_update_is_enabled(monkeypatch):
    calls = []
    monkeypatch.setattr(subprocess, "run", _pip_ok(calls))
    monkeypatch.delenv("YTDLP_AUTO_UPDATE", raising=False)
    monkeypatch.delenv("CURL_CFFI_AUTO_UPDATE", raising=False)

    assert apply_runtime_updates({}) is False
    assert calls == []


def test_a_failed_or_hung_pip_does_not_stop_the_start(monkeypatch):
    def hung(command, **kwargs):
        raise subprocess.TimeoutExpired(command, kwargs.get("timeout"))

    monkeypatch.setattr(subprocess, "run", hung)
    monkeypatch.delitem(sys.modules, "yt_dlp", raising=False)
    assert apply_runtime_updates({"YTDLP_AUTO_UPDATE": "true"}) is False


def test_the_entry_points_update_before_importing_the_api():
    """`shared.api` imports yt-dlp, so every entry point must update first."""
    import ast

    root = Path(__file__).resolve().parents[1]
    for rel in ("run.py", "shared/container_entrypoint.py", "shared/desktop_engine_entry.py"):
        tree = ast.parse((root / rel).read_text(encoding="utf-8"))
        for function in (n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef)):
            update = api = None
            for node in ast.walk(function):
                if isinstance(node, ast.Call) and getattr(node.func, "id", None) == "apply_runtime_updates":
                    update = node.lineno if update is None else min(update, node.lineno)
                if isinstance(node, ast.ImportFrom) and node.module == "shared.api":
                    api = node.lineno if api is None else min(api, node.lineno)
            if api is not None and any(a.name == "start_api" for n in ast.walk(function)
                                       if isinstance(n, ast.ImportFrom) and n.module == "shared.api"
                                       for a in n.names):
                assert update is not None and update < api, f"{rel}:{function.name} imports the API first"
