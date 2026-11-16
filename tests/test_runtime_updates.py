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
    # A repository venv beside the engine is not necessarily its environment.
    (tmp_path / ".venv" / "bin").mkdir(parents=True)
    (tmp_path / ".venv" / "bin" / "pip").touch()

    command = pip_upgrade_command(["yt-dlp", "curl-cffi"])

    assert command == [sys.executable, "-m", "pip", "install", "--upgrade", "yt-dlp", "curl-cffi"]


def test_pip_upgrade_command_rejects_empty_package_list():
    with pytest.raises(ValueError):
        pip_upgrade_command([])


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


ROOT = Path(__file__).resolve().parents[1]


def _fresh(code: str, tmp_path: Path) -> str:
    import os

    env = {**os.environ, "SOUNDSIBLE_CONFIG_DIR": str(tmp_path / "config"),
           "SOUNDSIBLE_DATA_DIR": str(tmp_path / "data"), "SOUNDSIBLE_CACHE_DIR": str(tmp_path / "cache")}
    result = subprocess.run([sys.executable, "-c", code], cwd=ROOT, env=env,
                            capture_output=True, text=True, timeout=120)
    assert result.returncode == 0, result.stderr[-2000:]
    return result.stdout.strip().splitlines()[-1]


@pytest.mark.parametrize("module", ["shared.engine_start", "shared.container_entrypoint", "shared.desktop_engine_entry"])
def test_importing_an_entry_point_loads_neither_tool(module, tmp_path):
    """Module-level and transitive imports count: they all happen before pip."""
    loaded = _fresh(
        f"import sys, {module}; print(sorted(m for m in ('yt_dlp', 'curl_cffi', 'shared.api') if m in sys.modules))",
        tmp_path,
    )
    assert loaded == "[]"


def test_the_daemon_runs_pip_before_it_imports_the_api(tmp_path):
    """Stub pip and the API; pip runs first, with neither tool loaded."""
    order = _fresh(
        """
import subprocess, sys, types
events = []
def fake_pip(command, **kwargs):
    events.append(("pip", "yt_dlp" in sys.modules, "curl_cffi" in sys.modules))
    return subprocess.CompletedProcess(command, 0, "", "")
subprocess.run = fake_pip
api = types.ModuleType("shared.api")
api.start_api = lambda **kwargs: events.append(("start_api",))
sys.modules["shared.api"] = api
import shared.downloader.settings as settings
settings.read_settings = lambda: {"YTDLP_AUTO_UPDATE": "true"}
from shared.engine_start import start_engine
start_engine(types.SimpleNamespace(host="127.0.0.1", port=0))
print(events)
""",
        tmp_path,
    )
    assert order == "[('pip', False, False), ('start_api',)]"


def test_the_desktop_engine_never_runs_pip(tmp_path):
    order = _fresh(
        """
import subprocess, sys, types
events = []
subprocess.run = lambda command, **kwargs: events.append("pip")
api = types.ModuleType("shared.api")
api.start_api = lambda **kwargs: events.append("start_api")
sys.modules["shared.api"] = api
import shared.downloader.settings as settings
settings.read_settings = lambda: {"YTDLP_AUTO_UPDATE": "true"}
from shared.engine_start import start_engine
start_engine(types.SimpleNamespace(host="127.0.0.1", port=0), update_tools=False)
print(events)
""",
        tmp_path,
    )
    assert order == "['start_api']"


def test_the_container_only_warns(caplog):
    import logging

    from shared.runtime_updates import warn_updates_need_a_new_image

    with caplog.at_level(logging.WARNING):
        warn_updates_need_a_new_image({"YTDLP_AUTO_UPDATE": "true"})
    assert "pull a newer image" in caplog.text


def test_run_py_imports_nothing_heavy_before_it_starts_the_engine():
    """run.py re-executes itself into the venv when imported, so it is read,
    not imported: nothing at its module level may pull in the API or a tool."""
    import ast

    tree = ast.parse((ROOT / "run.py").read_text(encoding="utf-8"))
    top = [n for n in tree.body if isinstance(n, (ast.Import, ast.ImportFrom))]
    names = {alias.name for n in top if isinstance(n, ast.Import) for alias in n.names}
    names |= {n.module for n in top if isinstance(n, ast.ImportFrom) and n.module}
    assert not {m for m in names if m.split(".")[0] in {"yt_dlp", "curl_cffi"} or m.startswith("shared.api")
                or m.startswith("shared.downloader")}
