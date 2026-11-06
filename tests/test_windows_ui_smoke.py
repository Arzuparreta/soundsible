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
    library = Mock()
    library.window_text.return_value = "Library"
    player.descendants.return_value = [library]
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
    library = Mock()
    library.window_text.return_value = "Library"
    player.descendants.return_value = [library]
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
