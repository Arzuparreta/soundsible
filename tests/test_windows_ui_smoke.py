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
