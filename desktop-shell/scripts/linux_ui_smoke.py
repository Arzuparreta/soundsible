#!/usr/bin/env python3
"""Drive the installed Linux app through WebKit WebDriver and real MPRIS.

Run under xvfb-run and dbus-run-session. All station/client data is disposable.
No UI/API mocks: an independent station serves the shared SolidJS player, a
WAV and an AAC (.m4a) track — the format YouTube downloads arrive in, which
WebKitGTK decodes through the distribution's GStreamer plugins.
"""
from __future__ import annotations

import argparse
import base64
import json
import math
import os
from pathlib import Path
import shutil
import signal
import struct
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import wave

MPRIS = "org.mpris.MediaPlayer2.soundsible"
OBJECT = "/org/mpris/MediaPlayer2"
PLAYER = "org.mpris.MediaPlayer2.Player"


def wait_for(callback, description, timeout=60):
    print(f"Checking {description}", flush=True)
    deadline = time.monotonic() + timeout
    error = None
    while time.monotonic() < deadline:
        try:
            value = callback()
            if value:
                return value
        except (OSError, ValueError, RuntimeError, urllib.error.URLError) as exc:
            error = exc
        time.sleep(0.2)
    raise RuntimeError(f"Timed out: {description}; last error: {error}")


def http(url, data=None, method=None, headers=None):
    request = urllib.request.Request(url, data=json.dumps(data).encode() if data is not None else None,
                                     headers={"Content-Type": "application/json", **(headers or {})}, method=method)
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


class WebDriver:
    def __init__(self, app):
        result = http("http://127.0.0.1:4444/session", {"capabilities": {"alwaysMatch": {
            "tauri:options": {"application": str(app)}, "acceptInsecureCerts": False,
        }}})["value"]
        self.session = result["sessionId"]

    def call(self, path, data=None, method=None):
        result = http(f"http://127.0.0.1:4444/session/{self.session}{path}", data, method)["value"]
        if isinstance(result, dict) and "error" in result:
            raise RuntimeError(str(result))
        return result

    def script(self, script):
        return self.call("/execute/sync", {"script": script, "args": []})

    def async_script(self, script):
        return self.call("/execute/async", {"script": script, "args": []})

    def element(self, selector):
        result = self.call("/element", {"using": "css selector", "value": selector})
        return result["element-6066-11e4-a52e-4f735466cecf"]

    def click(self, selector):
        element = wait_for(lambda: self.element(selector), selector)
        self.call(f"/element/{element}/click", {})

    def screenshot(self, path):
        try:
            path.write_bytes(base64.b64decode(self.call("/screenshot")))
        except (OSError, RuntimeError):
            # WebKitGTK sometimes cannot snapshot a dynamically created view.
            # Keep visual evidence from the real X display in that case.
            subprocess.run(["scrot", str(path)], check=True, timeout=10)

    def switch_player(self, origin):
        def select():
            for handle in self.call("/window/handles"):
                self.call("/window", {"handle": handle})
                if self.script("return location.origin") == origin:
                    return handle
            return None
        return wait_for(select, "external player window")


def bus(*args):
    result = subprocess.run(["busctl", "--user", *args], text=True, capture_output=True, timeout=10)
    if result.returncode:
        raise RuntimeError(result.stderr)
    return result.stdout.strip()


def property_value(name):
    return bus("get-property", MPRIS, OBJECT, PLAYER, name)


def player_call(name, *signature_and_values):
    return bus("call", MPRIS, OBJECT, PLAYER, name, *signature_and_values)


def sandboxed(flatpak, command, *extra):
    """Run `command` inside the installed Flatpak, sharing /tmp, where every
    path this smoke hands the app lives."""
    if not flatpak:
        return [str(command)]
    return ["flatpak", "run", "--filesystem=/tmp", *extra, f"--command={command}", flatpak]


def client_pid(flatpak):
    if not flatpak:
        return int(bus("call", "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus",
                       "GetConnectionUnixProcessID", "s", MPRIS).split()[-1])
    # Through Flatpak the bus sees xdg-dbus-proxy, not the app.
    for entry in Path("/proc").iterdir():
        try:
            if entry.name.isdigit() and os.readlink(entry / "exe").endswith("/soundsible-desktop"):
                return int(entry.name)
        except OSError:
            continue
    raise RuntimeError("no soundsible-desktop process")


def run(app, engine, artifacts, flatpak=None):
    artifacts.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="soundsible-linux-smoke-") as temporary:
        root = Path(temporary)
        music = root / "Música"
        music.mkdir()
        for index in range(2):
            with wave.open(str(music / f"smoke-{index}.wav"), "wb") as sound:
                sound.setparams((1, 2, 8000, 0, "NONE", "not compressed"))
                chunk = b"".join(struct.pack("<h", int(500 * math.sin(2 * math.pi * (440 + index * 110) * n / 8000))) for n in range(8000))
                for _ in range(90):
                    sound.writeframes(chunk)
        # Downloads are AAC in an MP4 container. WebKitGTK plays them only if
        # the distribution's GStreamer can decode AAC, which a WAV never asks.
        ffmpeg = shutil.which("ffmpeg")
        assert ffmpeg, "the AAC track is encoded with ffmpeg from PATH"
        subprocess.run([ffmpeg, "-loglevel", "error", "-i", str(music / "smoke-1.wav"),
                        "-c:a", "aac", "-b:a", "64k", str(music / "smoke-1.m4a")], check=True)
        (music / "smoke-1.wav").unlink()

        def environment(name):
            env = dict(os.environ)
            # OUTPUT_DIR has precedence over the desktop music-dir setting.
            # Keep portable library snapshots out of the user's default folder.
            output = root / name / "output"
            output.mkdir(parents=True)
            env["OUTPUT_DIR"] = str(output)
            for key, suffix in [("CONFIG", "config"), ("DATA", "data"), ("CACHE", "cache"), ("LOG", "logs")]:
                path = root / name / suffix
                path.mkdir(parents=True)
                env[f"SOUNDSIBLE_{key}_DIR"] = str(path)
            # Flatpak finds its per-user installation through XDG_DATA_HOME,
            # and replaces all three inside the sandbox anyway.
            if not flatpak:
                for kind in ("CONFIG", "DATA", "CACHE"):
                    env[f"XDG_{kind}_HOME"] = str(root / name / f"xdg-{kind.lower()}")
            return env

        station_env = environment("station")
        # The library is two local files; the station has no business on the
        # internet here. Opening the player asks the station for a listening
        # plan, which looks the songs up on YouTube, and a runner gets a bot
        # check that stretches that request to about 20 seconds. The player
        # does not wait for it (checked in Chromium and WebKit), but in the
        # driven WebKitGTK app the clicked track's stream was requested only
        # after it returned, and the run then failed on the wrong track. A proxy
        # nothing listens on makes every outside request fail at once.
        for variable in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
            station_env[variable] = "http://127.0.0.1:9"
        station_env["NO_PROXY"] = station_env["no_proxy"] = "127.0.0.1,localhost"
        client_env = environment("client")
        station_log = (artifacts / "station.log").open("w")
        driver_log = (artifacts / "driver.log").open("w")
        station = subprocess.Popen([*sandboxed(flatpak, engine), "--music-dir", str(music)], env=station_env,
                                   stdout=station_log, stderr=subprocess.STDOUT, start_new_session=True)
        driver = None
        web = None
        monitor = None
        monitor_log = None
        try:
            state_file = Path(station_env["SOUNDSIBLE_CONFIG_DIR"]) / "desktop-engine-state.json"
            state = wait_for(lambda: json.loads(state_file.read_text()) if state_file.exists() else None, "station state", 120)
            origin = state["base_url"]
            wait_for(lambda: http(origin + "/api/health"), "independent station health", 120)
            owner = Path(state["owner_token_file"]).read_text().strip()
            owner_headers = {"Authorization": f"Bearer {owner}"}
            http(origin + "/api/library/scan", {"path": str(music)}, headers=owner_headers)
            wait_for(lambda: http(origin + "/api/library/scan", headers=owner_headers)["state"] == "completed",
                     "completed library scan", 120)
            wait_for(lambda: len(http(origin + "/api/library")["tracks"]) == 2, "real WAV and AAC library scan", 120)
            (artifacts / "library.json").write_text(json.dumps(http(origin + "/api/library"), indent=2))
            sentinel = Path(client_env["SOUNDSIBLE_CONFIG_DIR"]) / "desktop-engine-state.json"
            sentinel_bytes = json.dumps(state).encode()
            sentinel.write_bytes(sentinel_bytes)
            initial_config = (Path(station_env["SOUNDSIBLE_CONFIG_DIR"]) / "config.json").read_bytes()
            # Inside a Flatpak the driver has to run in the sandbox too: it
            # starts the runtime's WebKitWebDriver, which starts the app.
            tauri_driver = Path(shutil.which("tauri-driver") or "tauri-driver")
            driver = subprocess.Popen(sandboxed(flatpak, tauri_driver, f"--filesystem={tauri_driver.parent}:ro"),
                                      env=client_env, stdout=driver_log,
                                      stderr=subprocess.STDOUT, start_new_session=True)
            wait_for(lambda: http("http://127.0.0.1:4444/status"), "tauri-driver")
            web = WebDriver(app)
            wait_for(lambda: web.script("return !document.getElementById('view-connection').classList.contains('hidden')"), "connection selection")
            web.screenshot(artifacts / "connection.png")
            field = web.element("#server-address")
            web.call(f"/element/{field}/value", {"text": "http://127.0.0.1:9"})
            web.click("#btn-connect")
            wait_for(lambda: web.script("return !document.getElementById('connection-error').classList.contains('hidden')"), "unreachable station error")
            web.call(f"/element/{field}/clear", {})
            web.call(f"/element/{field}/value", {"text": origin})
            web.click("#btn-connect")
            web.switch_player(origin)
            wait_for(lambda: web.script("return !!window.__SOUNDSIBLE_DESKTOP__"), "injected bridge")
            # The real remote WebView must not inherit local command capabilities.
            denied = web.async_script("""
              const done = arguments[arguments.length - 1];
              window.__TAURI_INTERNALS__.invoke('get_selected_folder')
                .then(() => done('ALLOWED'), error => done(String(error)));
            """)
            assert denied != "ALLOWED" and any(word in denied.lower() for word in ["denied", "not allowed", "not permitted"]), denied
            web.call("/url", {"url": origin + "/player/#/library?view=songs"})
            (artifacts / "player-dom.html").write_text(web.script("return document.documentElement.outerHTML"))
            rows = '[data-music-list-row] [data-row-main], [data-song-row] [role="button"]'
            titles = wait_for(lambda: web.script(f"return [...document.querySelectorAll('{rows}')].map(row => row.textContent.trim())") or None,
                              "station library rows", 120)
            assert sorted(titles) == ["smoke-0", "smoke-1"], titles
            first_title, second_title = titles
            # Observe actual media elements without replacing their playback.
            web.script("""
              window.__smokeAudio = [];
              const play = HTMLMediaElement.prototype.play;
              HTMLMediaElement.prototype.play = function (...args) {
                if (!window.__smokeAudio.includes(this)) window.__smokeAudio.push(this);
                return play.apply(this, args);
              };
            """)
            # Select the captured track by its accessible name. Library updates
            # can reorder rows between reading them and WebDriver's click.
            web.click(f'[data-row-main][aria-label^="Play {first_title} by "]')
            wait_for(lambda: property_value("PlaybackStatus") == 's "Playing"', "MPRIS playing")
            audio_position = "return Math.max(0, ...window.__smokeAudio.filter(a => !a.paused && a.duration > 1).map(a => a.currentTime))"
            wait_for(lambda: web.script(audio_position) > 0.2, "real HTML audio started")
            actual_position = web.script(audio_position)
            wait_for(lambda: web.script(audio_position) > actual_position + 0.3, "real HTML audio position advanced")
            metadata = property_value("Metadata")
            assert first_title in metadata, metadata
            first_position = property_value("Position")
            wait_for(lambda: property_value("Position") != first_position, "MPRIS position advanced")
            web.screenshot(artifacts / "playing.png")
            player_call("Pause")
            wait_for(lambda: property_value("PlaybackStatus") == 's "Paused"', "MPRIS pause")
            player_call("Next")
            wait_for(lambda: second_title in property_value("Metadata"), "next track while paused")
            assert property_value("PlaybackStatus") == 's "Paused"'
            player_call("Play")
            wait_for(lambda: property_value("PlaybackStatus") == 's "Playing"', "MPRIS resume")
            wait_for(lambda: web.script(audio_position) > 0.2, "second real HTML audio started")
            player_call("Seek", "x", "5000000")
            wait_for(lambda: web.script(audio_position) >= 5, "real audio seek")
            bus("set-property", MPRIS, OBJECT, PLAYER, "Volume", "d", "0.25")
            wait_for(lambda: property_value("Volume") == "d 0.25", "MPRIS volume")
            player_call("Stop")
            wait_for(lambda: property_value("PlaybackStatus") == 's "Paused"', "stop retains queue")
            assert second_title in property_value("Metadata")
            assert sentinel.read_bytes() == sentinel_bytes, "client modified an external runtime state"
            assert not (Path(client_env["SOUNDSIBLE_CONFIG_DIR"]) / "config.json").exists(), "client created station configuration"
            preferences = json.loads((Path(client_env["SOUNDSIBLE_CONFIG_DIR"]) / "desktop-client.json").read_text())
            assert preferences == {"mode": "server", "server": origin}
            # Capture a lightweight resource baseline for this exact runtime.
            pid = client_pid(flatpak)
            children = subprocess.check_output(["ps", "-eo", "pid=,ppid="], text=True)
            owned = {pid}
            pairs = [tuple(map(int, line.split())) for line in children.splitlines()]
            while True:
                expanded = owned | {child for child, parent in pairs if parent in owned}
                if expanded == owned:
                    break
                owned = expanded
            for child in owned:
                executable = Path(f"/proc/{child}/exe")
                if executable.exists():
                    assert executable.resolve().name != engine.name, "client spawned a station engine"
            (artifacts / "processes.txt").write_text(subprocess.check_output(["ps", "-eo", "pid,ppid,rss,pcpu,comm"], text=True))
            (artifacts / "client-status.txt").write_text(Path(f"/proc/{pid}/status").read_text())
            # Check notification-driven widgets, not only synchronous getters:
            # switching away must publish the transition to empty media state.
            monitor_path = artifacts / "mpris-changes.log"
            monitor_log = monitor_path.open("w")
            monitor = subprocess.Popen([
                "dbus-monitor", "--session",
                f"type='signal',interface='org.freedesktop.DBus.Properties',member='PropertiesChanged',path='{OBJECT}'",
            ], stdout=monitor_log, stderr=subprocess.STDOUT, start_new_session=True)
            wait_for(lambda: "NameAcquired" in monitor_path.read_text(), "MPRIS signal monitor ready")

            def select_shell():
                for handle in web.call("/window/handles"):
                    web.call("/window", {"handle": handle})
                    if web.script("return !!document.getElementById('view-connection')"):
                        return handle
                return None

            wait_for(select_shell, "configuration window")
            web.async_script("""
              const done = arguments[arguments.length - 1];
              window.__TAURI_INTERNALS__.invoke('change_connection').then(() => done(true), error => done(String(error)));
            """)
            wait_for(lambda: '"PlaybackStatus"' in monitor_path.read_text()
                     and '"Stopped"' in monitor_path.read_text()
                     and '"Metadata"' in monitor_path.read_text(), "MPRIS clearing signals")
            assert second_title not in property_value("Metadata")
            bus("call", MPRIS, OBJECT, "org.mpris.MediaPlayer2", "Quit")
            wait_for(lambda: bus("call", "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "NameHasOwner", "s", MPRIS) == "b false", "client exited")
            wait_for(lambda: station.poll() is None and http(origin + "/api/health"), "server survives client quit")
            assert sentinel.read_bytes() == sentinel_bytes
            assert (Path(station_env["SOUNDSIBLE_CONFIG_DIR"]) / "config.json").read_bytes() == initial_config
            (artifacts / "result.json").write_text(json.dumps({
                "installed_app": str(app), "remote_acl_denial": denied, "mpris": "passed",
                "real_audio_position": "advanced", "client_engine_spawned": False,
                "server_survives_quit": True,
                "connection_switch_clears_mpris_signals": True,
            }, indent=2))
            print("Linux installed-app smoke passed: real player, WAV and AAC playback, MPRIS, remote ACL and independent server lifecycle.", flush=True)
        except Exception:
            if web:
                try:
                    (artifacts / "audio.json").write_text(json.dumps(web.script("""
                      return (window.__smokeAudio || []).map(a => ({
                        source: a.src ? new URL(a.src).pathname : '',
                        position: a.currentTime, duration: Number.isFinite(a.duration) ? a.duration : null,
                        ready: a.readyState, network: a.networkState, paused: a.paused,
                        error: a.error ? { code: a.error.code, message: a.error.message } : null,
                      }));
                    """), indent=2))
                    (artifacts / "failure-dom.html").write_text(web.script("return document.documentElement.outerHTML"))
                except Exception:
                    pass
                try:
                    web.screenshot(artifacts / "failure.png")
                except Exception:
                    pass
            raise
        finally:
            if driver:
                try:
                    bus("call", MPRIS, OBJECT, "org.mpris.MediaPlayer2", "Quit")
                except (RuntimeError, subprocess.TimeoutExpired):
                    pass
            if web:
                try:
                    web.call("", method="DELETE")
                except (OSError, RuntimeError):
                    pass
            for process in (monitor, driver, station):
                if process and process.poll() is None:
                    os.killpg(process.pid, signal.SIGTERM)
                    try:
                        process.wait(timeout=20)
                    except subprocess.TimeoutExpired:
                        os.killpg(process.pid, signal.SIGKILL)
                        process.wait(timeout=5)
            station_log.close()
            driver_log.close()
            if monitor_log:
                monitor_log.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--app", type=Path, required=True)
    parser.add_argument("--engine", type=Path, required=True)
    parser.add_argument("--artifacts", type=Path, required=True)
    parser.add_argument("--flatpak", metavar="APP_ID",
                        help="run the app and engine from this installed Flatpak; --app and --engine are then paths inside it")
    args = parser.parse_args()
    if args.flatpak:
        run(args.app, args.engine, args.artifacts.resolve(), args.flatpak)
    else:
        run(args.app.resolve(), args.engine.resolve(), args.artifacts.resolve())
