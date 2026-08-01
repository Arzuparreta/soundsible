"""Exercise the installed Soundsible shell through Windows UI Automation."""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import struct
import subprocess
import time
import wave
from pathlib import Path

from PIL import ImageGrab
from pywinauto import Desktop
from pywinauto.keyboard import send_keys


def wait_until(predicate, message: str, timeout: float = 30.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.25)
    raise TimeoutError(message)


def screenshot(path: Path) -> None:
    ImageGrab.grab(all_screens=True).save(path)


def dump_tree(window, path: Path) -> None:
    lines = []
    for control in window.descendants():
        info = control.element_info
        lines.append(
            f"{info.control_type}\t{info.name!r}\t"
            f"automation_id={info.automation_id!r}\tclass={info.class_name!r}"
        )
    path.write_text("\n".join(lines), encoding="utf-8")


def main_window(pid: int):
    desktop = Desktop(backend="uia")
    return wait_until(
        lambda: next(
            (
                window
                for window in desktop.windows(process=pid)
                if window.window_text() == "Soundsible"
            ),
            None,
        ),
        "Soundsible main window did not appear",
    )


def control(window, title: str, control_type: str = "Button", timeout: float = 30.0):
    title_pattern = rf"^{re.escape(title)}(?:…|\.\.\.)?$"
    # ``Desktop.windows`` returns a UIAWrapper, while ``child_window`` belongs
    # to WindowSpecification. Re-wrap the stable native handle before querying.
    root = (
        window
        if hasattr(window, "child_window")
        else Desktop(backend="uia").window(handle=window.handle)
    )
    spec = root.child_window(title_re=title_pattern, control_type=control_type)
    spec.wait("exists enabled visible ready", timeout=timeout)
    return spec.wrapper_object()


def invoke_or_click(item) -> None:
    try:
        item.invoke()
    except Exception:
        item.click_input()


def dismiss_runner_first_boot(desktop) -> bool:
    """Dismiss the hosted runner's privacy OOBE if Explorer starts it."""

    for window in desktop.windows():
        try:
            controls = window.descendants()
        except Exception:
            continue

        if not any(
            item.window_text() == "Choose privacy settings for your device"
            for item in controls
        ):
            continue

        buttons = [
            item
            for item in controls
            if item.element_info.control_type == "Button"
            and item.is_visible()
            and item.is_enabled()
        ]
        button = next(
            (
                item
                for label in ("Next", "Accept")
                for item in buttons
                if item.window_text() == label
            ),
            None,
        )
        # The ARM image occasionally loses the accessible label while the
        # primary blue button remains visible. Restrict the fallback to wide
        # controls in the lower part of the privacy card so the separate
        # accessibility shortcut in the bottom-right corner is never chosen.
        if button is None and buttons:
            primary_buttons = [
                item
                for item in buttons
                if item.rectangle().width() >= 100 and item.rectangle().top >= 500
            ]
            if primary_buttons:
                button = max(
                    primary_buttons,
                    key=lambda item: item.rectangle().left,
                )

        if button is not None:
            print(
                "Dismissing runner privacy OOBE with "
                f"{button.window_text()!r} at {button.rectangle()}",
                flush=True,
            )
            button.click_input()
        else:
            print("Dismissing runner privacy OOBE with Enter", flush=True)
            window.set_focus()
            send_keys("{ENTER}")
        time.sleep(1.5)
        return True
    return False


def folder_dialog(reopen_after_oobe=None):
    desktop = Desktop(backend="uia")
    dismissed_oobe = False
    reopened_picker = False

    def picker_window():
        for window in desktop.windows():
            candidates = [window]
            try:
                candidates.extend(window.descendants(control_type="Window"))
            except Exception:
                pass
            match = next(
                (
                    candidate
                    for candidate in candidates
                    if candidate.window_text().startswith(
                        "Choose your music folder"
                    )
                ),
                None,
            )
            if match is not None:
                return match
        return None

    def find_dialog():
        nonlocal dismissed_oobe, reopened_picker
        # A fresh Windows ARM hosted runner can defer its privacy OOBE until
        # Explorer first opens. Clear that system-owned screen, then continue
        # waiting for the folder picker that the app requested.
        if dismiss_runner_first_boot(desktop):
            dismissed_oobe = True
            return None
        if dismissed_oobe and not reopened_picker and reopen_after_oobe is not None:
            # Windows discards the original picker request while its OOBE owns
            # the desktop. Ask the app to open it again after Accept closes.
            reopen_after_oobe()
            reopened_picker = True
            return None
        return picker_window()

    return wait_until(
        find_dialog,
        "Native folder picker did not appear",
        timeout=60,
    )


def set_clipboard_text(value: str) -> None:
    subprocess.run(
        [
            "powershell",
            "-NoProfile",
            "-Command",
            "Set-Clipboard -Value $args[0]",
            value,
        ],
        check=True,
    )


def choose_unicode_folder(window, music_path: Path, artifact_path: Path) -> None:
    def reopen_picker_after_oobe() -> None:
        # Explorer owns the foreground after Windows finishes its deferred
        # privacy OOBE. Invoke the covered WebView button through UIA instead
        # of sending a physical click to Explorer's coordinates.
        print("Reopening folder picker after runner privacy OOBE", flush=True)
        chooser = control(window, "Choose folder", timeout=10)
        try:
            chooser.invoke()
            print("Reopened folder picker through UIA Invoke", flush=True)
        except Exception as error:
            print(f"UIA Invoke failed, using focused click: {error}", flush=True)
            window.set_focus()
            time.sleep(0.5)
            chooser.click_input()

    control(window, "Choose folder").click_input()
    dialog = folder_dialog(reopen_picker_after_oobe)
    screenshot(artifact_path / "picker-cancel.png")
    invoke_or_click(control(dialog, "Cancel", timeout=10))
    control(window, "Choose folder", timeout=10)

    invoke_or_click(control(window, "Choose folder"))
    dialog = folder_dialog()
    dialog.set_focus()
    set_clipboard_text(str(music_path))
    send_keys("^l")
    send_keys("^v")
    send_keys("{ENTER}")
    invoke_or_click(control(dialog, "Select Folder", timeout=10))


def wait_for_engine_state(state_file: Path, timeout: float = 120.0) -> dict:
    wait_until(
        state_file.is_file,
        "Desktop engine state was not created",
        timeout=timeout,
    )
    return json.loads(state_file.read_text(encoding="utf-8"))


def assert_healthy(state: dict) -> None:
    import urllib.request

    with urllib.request.urlopen(
        f"{state['base_url']}{state['health']}", timeout=10
    ) as response:
        health = json.load(response)
    if health.get("status") != "healthy":
        raise RuntimeError("Desktop engine health was not healthy")


def global_shortcut(keys: str) -> None:
    send_keys(keys, pause=0.05)


def wait_for_exit(process: subprocess.Popen, message: str, timeout: float = 15.0):
    try:
        process.wait(timeout=timeout)
    except subprocess.TimeoutExpired as error:
        raise RuntimeError(message) from error


def run_smoke(app_path: Path, artifact_path: Path) -> None:
    runner_temp = Path(os.environ["RUNNER_TEMP"])
    music_path = runner_temp / "Música de prueba"
    config_path = runner_temp / "soundsible-ui-config"
    shutil.rmtree(config_path, ignore_errors=True)
    music_path.mkdir(parents=True, exist_ok=True)
    artifact_path.mkdir(parents=True, exist_ok=True)

    with wave.open(str(music_path / "silencio.wav"), "wb") as wav:
        wav.setparams((1, 2, 8000, 800, "NONE", "not compressed"))
        wav.writeframes(struct.pack("<800h", *([0] * 800)))

    environment = os.environ.copy()
    environment["SOUNDSIBLE_CONFIG_DIR"] = str(config_path)
    state_file = config_path / "desktop-engine-state.json"
    process = subprocess.Popen([app_path], env=environment)

    try:
        window = main_window(process.pid)
        control(window, "Choose folder")
        dump_tree(window, artifact_path / "onboarding-tree.txt")
        screenshot(artifact_path / "onboarding.png")
        choose_unicode_folder(window, music_path, artifact_path)

        control(window, "Continue", timeout=30)
        wait_until(
            lambda: any("1 track" in item.window_text() for item in window.descendants()),
            "Selected folder summary did not report one track",
            timeout=30,
        )
        screenshot(artifact_path / "folder-selected.png")
        control(window, "Continue").click_input()

        state = wait_for_engine_state(state_file)
        assert_healthy(state)
        screenshot(artifact_path / "player-ready.png")

        # A second launch must bypass onboarding and reuse the saved folder.
        window.set_focus()
        global_shortcut("^%q")
        wait_for_exit(process, "Global quit shortcut did not terminate first launch")
        wait_until(
            lambda: not state_file.exists(),
            "Engine state remained after first launch exited",
            timeout=15,
        )

        process = subprocess.Popen([app_path], env=environment)
        window = main_window(process.pid)
        state = wait_for_engine_state(state_file)
        assert_healthy(state)
        screenshot(artifact_path / "returning-user.png")

        # Alt+F4 hides to tray. Ctrl+Alt+O restores the same process.
        window.set_focus()
        send_keys("%{F4}")
        time.sleep(2)
        if process.poll() is not None:
            raise RuntimeError("Closing the window exited instead of hiding to tray")
        global_shortcut("^%o")
        main_window(process.pid).wait("visible", timeout=10)
        screenshot(artifact_path / "restored-from-tray.png")

        global_shortcut("^%q")
        wait_for_exit(process, "Global quit shortcut did not terminate Soundsible")
    except Exception:
        screenshot(artifact_path / "failure.png")
        raise
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=10)
        logs_path = config_path / "logs"
        if logs_path.is_dir():
            shutil.copytree(
                logs_path,
                artifact_path / "logs",
                dirs_exist_ok=True,
            )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--app", type=Path, required=True)
    parser.add_argument("--artifacts", type=Path, required=True)
    return parser.parse_args()


if __name__ == "__main__":
    arguments = parse_args()
    run_smoke(arguments.app.resolve(), arguments.artifacts.resolve())
