"""Exercise Windows smoke synchronization without requiring a Windows desktop."""

import importlib.util
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest.mock import Mock

import pytest


@pytest.fixture
def smoke(monkeypatch):
    for name in ("pywinauto", "pywinauto.keyboard", "pywinauto.timings"):
        monkeypatch.setitem(sys.modules, name, ModuleType(name))
    sys.modules["pywinauto"].Desktop = Mock()
    sys.modules["pywinauto.keyboard"].send_keys = Mock()
    sys.modules["pywinauto.timings"].TimeoutError = TimeoutError
    path = Path(__file__).resolve().parents[1] / "desktop-shell/scripts/windows_ui_smoke.py"
    spec = importlib.util.spec_from_file_location("windows_ui_smoke", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setattr(module.time, "sleep", lambda _: None)
    module.real_native_window_visible = module.native_window_visible
    monkeypatch.setattr(module, "native_window_visible", lambda window: window.is_visible())
    return module


def test_control_clears_runner_oobe_and_waits_for_webview(smoke, monkeypatch):
    spec = Mock()
    spec.wait.side_effect = [TimeoutError(), None]
    window = SimpleNamespace(child_window=Mock(return_value=spec))
    dismiss = Mock(side_effect=[True, False, False])
    monkeypatch.setattr(smoke, "dismiss_runner_first_boot", dismiss)

    assert smoke.control(window, "Choose folder") is spec.wrapper_object.return_value
    assert dismiss.call_count == 3
    assert spec.wait.call_count == 2
    window.child_window.assert_called_once_with(title_re=r"^Choose\ folder(?:…|\.\.\.)?$", control_type="Button")


def test_control_does_not_hide_unexpected_uia_failures(smoke, monkeypatch):
    spec = Mock()
    spec.wait.side_effect = RuntimeError("UIA failed")
    window = SimpleNamespace(child_window=Mock(return_value=spec))
    monkeypatch.setattr(smoke, "dismiss_runner_first_boot", lambda _: False)
    with pytest.raises(RuntimeError, match="UIA failed"):
        smoke.control(window, "Continue")


def test_player_waits_past_healthy_engine_and_same_title_shell(smoke, monkeypatch):
    shell = Mock()
    shell.window_text.return_value = "Soundsible"
    shell.is_visible.return_value = True
    shell.descendants.return_value = []
    player = Mock()
    player.window_text.return_value = "Soundsible"
    player.is_visible.return_value = True
    home = Mock()
    home.window_text.return_value = "Home"
    player.descendants.return_value = [home]
    desktop = smoke.Desktop.return_value
    desktop.windows.side_effect = [[shell], [shell, player]]

    assert smoke.player_window(123) is player
    assert desktop.windows.call_count == 2
    desktop.windows.assert_called_with(process=123)


def test_player_ignores_hidden_previous_window(smoke):
    hidden = Mock()
    hidden.window_text.return_value = "Soundsible"
    hidden.is_visible.return_value = False
    player = Mock()
    player.window_text.return_value = "Soundsible"
    player.is_visible.return_value = True
    home = Mock()
    home.window_text.return_value = "Home"
    player.descendants.return_value = [home]
    smoke.Desktop.return_value.windows.return_value = [hidden, player]

    assert smoke.player_window(123) is player
    hidden.descendants.assert_not_called()


def test_native_visibility_uses_hwnd_instead_of_stale_uia(smoke, monkeypatch):
    native = ModuleType("win32gui")
    native.IsWindowVisible = Mock(return_value=0)
    monkeypatch.setitem(sys.modules, "win32gui", native)
    window = SimpleNamespace(handle=456, is_visible=Mock(return_value=True))

    assert smoke.real_native_window_visible(window) is False
    native.IsWindowVisible.assert_called_once_with(456)
    window.is_visible.assert_not_called()


def test_prepare_smoke_environment_uses_default_dir_and_drops_inherited_override(
    smoke, monkeypatch, tmp_path
):
    local = (tmp_path / "Local" / "soundsible").resolve()
    roaming = (tmp_path / "Roaming" / "soundsible").resolve()
    monkeypatch.setattr(smoke, "default_config_dir", lambda: local)
    monkeypatch.setattr(smoke, "legacy_roaming_config_dir", lambda: roaming)

    env, config_path, roaming_path = smoke.prepare_smoke_environment(
        {"SOUNDSIBLE_CONFIG_DIR": "/stale/override", "PATH": "x"},
        None,
    )

    assert "SOUNDSIBLE_CONFIG_DIR" not in env
    assert env["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"] == "--disable-gpu"
    assert config_path == local
    assert roaming_path == roaming


def test_prepare_smoke_environment_omits_roaming_when_identical(
    smoke, monkeypatch, tmp_path
):
    shared = (tmp_path / "soundsible").resolve()
    monkeypatch.setattr(smoke, "default_config_dir", lambda: shared)
    monkeypatch.setattr(smoke, "legacy_roaming_config_dir", lambda: shared)

    env, config_path, roaming_path = smoke.prepare_smoke_environment({}, None)

    assert "SOUNDSIBLE_CONFIG_DIR" not in env
    assert config_path == shared
    assert roaming_path is None


def test_prepare_smoke_environment_respects_explicit_config_dir(smoke, tmp_path):
    explicit = tmp_path / "isolated"
    env, config_path, roaming_path = smoke.prepare_smoke_environment({}, explicit)

    assert env["SOUNDSIBLE_CONFIG_DIR"] == str(explicit.resolve())
    assert config_path == explicit.resolve()
    assert roaming_path is None


def test_run_smoke_refuses_to_clear_existing_default_profile_outside_ci(
    smoke, monkeypatch, tmp_path
):
    existing_default = tmp_path / "Local" / "soundsible"
    existing_default.mkdir(parents=True)
    monkeypatch.setenv("RUNNER_TEMP", str(tmp_path / "runner"))
    monkeypatch.delenv("GITHUB_ACTIONS", raising=False)
    monkeypatch.setattr(smoke, "default_config_dir", lambda: existing_default.resolve())
    monkeypatch.setattr(smoke, "legacy_roaming_config_dir", lambda: existing_default.resolve())

    with pytest.raises(RuntimeError, match="Refusing to clear"):
        smoke.run_smoke(tmp_path / "Soundsible.exe", tmp_path / "artifacts")
    assert existing_default.exists()
