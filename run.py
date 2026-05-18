#!/usr/bin/env python3
"""
Soundsible Universal Launcher
The single entry point for all Soundsible components (Player, Downloader, Setup).
"""
# Note: Prepend venv site-packages so "python3 run.py" finds gevent and other deps (same as using ./venv/bin/python).
import argparse
import sys
import subprocess
import hashlib
from pathlib import Path
import platform
import shutil
import os
# Note: Gevent monkey-patching must happen early, but only after deps are ensured.


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Soundsible launcher and engine entrypoint.")
    parser.add_argument("--setup", action="store_true", help="Run the setup web UI.")
    parser.add_argument("--daemon", action="store_true", help="Run the legacy Station Engine daemon.")
    parser.add_argument("--desktop-engine", action="store_true", help="Run the desktop engine entrypoint on loopback.")
    parser.add_argument("--host", help="Bind host override for daemon or desktop engine mode.")
    parser.add_argument("--port", type=int, help="Bind port override for daemon or desktop engine mode. Use 0 for a random port.")
    parser.add_argument("--config-dir", help="Runtime config directory override.")
    parser.add_argument("--data-dir", help="Runtime data directory override.")
    parser.add_argument("--cache-dir", help="Runtime cache directory override.")
    parser.add_argument("--log-dir", help="Runtime log directory override.")
    parser.add_argument("--music-dir", help="Runtime music directory override.")
    parser.add_argument("--ui-dist", help="UI dist directory override.")
    parser.add_argument("--owner-token-file", help="Owner token file path override.")
    parser.add_argument("--lan-enabled", dest="lan_enabled", action="store_true", help="Enable LAN access in runtime config.")
    parser.add_argument("--no-lan", dest="lan_enabled", action="store_false", help="Disable LAN access in runtime config.")
    parser.add_argument("--advanced-mode", action="store_true", help="Enable advanced/headless runtime mode.")
    parser.set_defaults(lan_enabled=None)
    return parser


def _seed_runtime_env_from_args(args: argparse.Namespace) -> None:
    mappings = {
        "config_dir": "SOUNDSIBLE_CONFIG_DIR",
        "data_dir": "SOUNDSIBLE_DATA_DIR",
        "cache_dir": "SOUNDSIBLE_CACHE_DIR",
        "log_dir": "SOUNDSIBLE_LOG_DIR",
        "music_dir": "SOUNDSIBLE_MUSIC_DIR",
        "ui_dist": "SOUNDSIBLE_UI_DIST",
        "owner_token_file": "SOUNDSIBLE_OWNER_TOKEN_FILE",
    }
    for attr, env_key in mappings.items():
        value = getattr(args, attr, None)
        if value:
            os.environ[env_key] = str(value)
    if args.host:
        os.environ["SOUNDSIBLE_HOST"] = args.host
    if args.port is not None:
        os.environ["SOUNDSIBLE_PORT"] = str(args.port)
    if args.lan_enabled is not None:
        os.environ["SOUNDSIBLE_LAN_ENABLED"] = "true" if args.lan_enabled else "false"
    if args.advanced_mode:
        os.environ["SOUNDSIBLE_ADVANCED_MODE"] = "true"


if any(arg in {"-h", "--help"} for arg in sys.argv[1:]):
    build_parser().print_help()
    raise SystemExit(0)

_BOOTSTRAP_ARGS, _ = build_parser().parse_known_args()
_seed_runtime_env_from_args(_BOOTSTRAP_ARGS)


def _venv_python_path(venv_dir: Path) -> Path:
    return venv_dir / ("Scripts/python.exe" if platform.system() == "Windows" else "bin/python")


def _venv_site_packages_path(venv_dir: Path) -> Path:
    return venv_dir / (
        "Lib/site-packages"
        if platform.system() == "Windows"
        else f"lib/python{sys.version_info.major}.{sys.version_info.minor}/site-packages"
    )


def _venv_has_pip(py: Path) -> bool:
    if not py.exists():
        return False
    result = subprocess.run(
        [str(py), "-m", "pip", "--version"],
        capture_output=True,
        text=True,
    )
    return result.returncode == 0


def _venv_can_import(py: Path, modules: list[str]) -> tuple[bool, str]:
    if not py.exists():
        return False, "venv python executable is missing"
    result = subprocess.run(
        [str(py), "-c", "import importlib, sys; [importlib.import_module(m) for m in sys.argv[1:]]", *modules],
        capture_output=True,
        text=True,
    )
    if result.returncode == 0:
        return True, ""
    return False, (result.stderr or result.stdout or "module import check failed").strip()


def _running_in_project_venv(venv_dir: Path) -> bool:
    return Path(sys.prefix).resolve() == venv_dir.resolve()


def _recreate_venv(venv_dir: Path) -> None:
    if venv_dir.exists():
        shutil.rmtree(venv_dir, ignore_errors=True)
    print("Creating virtual environment...", flush=True)
    subprocess.check_call([sys.executable, "-m", "venv", str(venv_dir)])


def _ensure_venv_with_pip(venv_dir: Path) -> Path:
    py = _venv_python_path(venv_dir)
    needs_recreate = not venv_dir.exists() or not py.exists()

    if needs_recreate:
        _recreate_venv(venv_dir)
        py = _venv_python_path(venv_dir)

    if _venv_has_pip(py):
        return py

    print("Repairing virtual environment pip bootstrap...", flush=True)
    ensurepip = subprocess.run(
        [str(py), "-m", "ensurepip", "--upgrade"],
        capture_output=True,
        text=True,
    )
    if _venv_has_pip(py):
        return py

    print("Virtual environment pip bootstrap failed; recreating environment...", flush=True)
    _recreate_venv(venv_dir)
    py = _venv_python_path(venv_dir)

    ensurepip_retry = subprocess.run(
        [str(py), "-m", "ensurepip", "--upgrade"],
        capture_output=True,
        text=True,
    )
    if _venv_has_pip(py):
        return py

    details = (ensurepip_retry.stderr or ensurepip_retry.stdout or ensurepip.stderr or ensurepip.stdout).strip()
    if platform.system() != "Windows":
        details += (
            "\nInstall the OS packages that provide venv + pip wheels, then rerun:\n"
            f"  sudo apt install python{sys.version_info.major}.{sys.version_info.minor}-venv python3-pip"
        )
    raise RuntimeError(details or "Failed to create a usable virtual environment with pip.")


def _ensure_bootstrap_before_gevent():
    """Create venv and install requirements before importing gevent.

    Fresh clones may not have a venv yet; importing gevent before bootstrap would
    fail with ModuleNotFoundError and prevent self-healing.
    """
    root_dir = Path(__file__).resolve().parent
    venv_dir = root_dir / "venv"
    req_file = root_dir / "requirements.txt"
    marker = venv_dir / ".installed_requirements_hash"
    bootstrap_modules = ["pip", "gevent", "zope.event", "zope.interface", "rich"]

    try:
        py = _ensure_venv_with_pip(venv_dir)
    except Exception as exc:
        print("Virtual environment setup failed:", exc)
        sys.exit(1)

    if req_file.exists() and py.exists():
        current_hash = hashlib.md5(req_file.read_bytes()).hexdigest()
        env_ok, env_error = _venv_can_import(py, bootstrap_modules)
        if not marker.exists() or marker.read_text() != current_hash or not env_ok:
            print("Installing/Updating requirements...", flush=True)
            result = subprocess.run(
                [str(py), "-m", "pip", "install", "--upgrade", "pip", "setuptools", "wheel"],
            )
            if result.returncode != 0:
                print("Bootstrap tool upgrade failed.")
                sys.exit(1)
            result = subprocess.run(
                [str(py), "-m", "pip", "install", "--upgrade", "-r", str(req_file)],
            )
            if result.returncode != 0:
                print("Requirement installation failed.")
                sys.exit(1)
            env_ok, env_error = _venv_can_import(py, bootstrap_modules)
            if not env_ok:
                print("Virtual environment verification failed:", env_error)
                print("Recreating virtual environment and retrying once...", flush=True)
                try:
                    _recreate_venv(venv_dir)
                    py = _ensure_venv_with_pip(venv_dir)
                except Exception as exc:
                    print("Virtual environment recreation failed:", exc)
                    sys.exit(1)
                result = subprocess.run(
                    [str(py), "-m", "pip", "install", "--upgrade", "pip", "setuptools", "wheel"],
                )
                if result.returncode != 0:
                    print("Bootstrap tool upgrade failed.")
                    sys.exit(1)
                result = subprocess.run(
                    [str(py), "-m", "pip", "install", "--upgrade", "-r", str(req_file)],
                )
                if result.returncode != 0:
                    print("Requirement installation failed.")
                    sys.exit(1)
                env_ok, env_error = _venv_can_import(py, bootstrap_modules)
                if not env_ok:
                    print("Virtual environment verification failed after rebuild:", env_error)
                    sys.exit(1)
            marker.write_text(current_hash)

    # Re-exec under the project virtualenv so imports happen in the exact
    # interpreter environment that installed the dependencies. Do not compare
    # resolved executable paths here: Ubuntu venv/bin/python is commonly a
    # symlink to /usr/bin/python3.12, so path resolution would falsely say the
    # system interpreter is already the venv interpreter.
    target_exe = py.absolute()
    if not _running_in_project_venv(venv_dir):
        env = os.environ.copy()
        env["SOUNDSIBLE_BOOTSTRAPPED"] = "1"
        os.execve(str(target_exe), [str(target_exe), str(root_dir / "run.py"), *sys.argv[1:]], env)

    # If the process was re-execed but still did not enter the venv, fail with
    # explicit state instead of falling back to mixed system/venv imports.
    if os.environ.get("SOUNDSIBLE_BOOTSTRAPPED") == "1" and not _running_in_project_venv(venv_dir):
        print("Virtual environment activation failed after re-exec.")
        print("sys.executable:", sys.executable)
        print("sys.prefix:", sys.prefix)
        print("expected venv:", venv_dir)
        sys.exit(1)


_ensure_bootstrap_before_gevent()

# Note: Gevent must patch before imports that use socket/threading.
from gevent import monkey
monkey.patch_all()

import socket
import threading
import time
import webbrowser
import json
import atexit
import signal
from datetime import datetime
from pathlib import Path

from shared.constants import STATION_PORT
from shared.runtime import (
    RuntimeConfig,
    configure_runtime,
    ensure_runtime_directories,
    get_config_dir,
    migrate_legacy_app_dirs,
    runtime_with_overrides,
)

PLAYER_URL = f"http://localhost:{STATION_PORT}/player/"
LAUNCHER_PORT = int(os.environ.get("LAUNCHER_PORT", "5099"))
SETUP_URL = f"http://localhost:{LAUNCHER_PORT}/setup"

# Note: VENV bootstrap
ROOT_DIR = Path(__file__).parent.absolute()
VENV_DIR = ROOT_DIR / "venv"
PYTHON_EXE = VENV_DIR / ("Scripts\\python.exe" if platform.system() == "Windows" else "bin/python")

from shared.daemon_launcher import (
    start_daemon_process,
    stop_daemon_process,
    MSG_KEEP_TERMINAL_OPEN,
    MSG_CONFIG_MISSING,
    MSG_SETUP_REQUIRED,
)
from shared.desktop_runtime import (
    clear_runtime_state,
    ensure_owner_token,
    stop_owned_desktop_engine,
    write_runtime_state,
)


def _config_path() -> Path:
    return get_config_dir() / "config.json"


def _build_runtime_config(args: argparse.Namespace, *, desktop_defaults: bool) -> RuntimeConfig:
    base = RuntimeConfig.default()
    host = args.host
    port = args.port
    advanced_mode = args.advanced_mode or base.advanced_mode
    if desktop_defaults:
        if host is None:
            host = "127.0.0.1"
        if port is None:
            port = 0
        advanced_mode = False
    elif not args.advanced_mode and "SOUNDSIBLE_ADVANCED_MODE" not in os.environ:
        advanced_mode = True
    runtime = runtime_with_overrides(
        base=base,
        host=host,
        port=port,
        config_dir=args.config_dir,
        data_dir=args.data_dir,
        cache_dir=args.cache_dir,
        log_dir=args.log_dir,
        music_dir=args.music_dir,
        ui_dist=args.ui_dist,
        owner_token_file=args.owner_token_file,
        lan_enabled=args.lan_enabled,
        advanced_mode=advanced_mode,
    )
    if runtime.port == 0:
        bind_host, bind_port = runtime.resolved_bind()
        runtime = runtime_with_overrides(base=runtime, host=bind_host, port=bind_port)
    configure_runtime(runtime)
    migrate_legacy_app_dirs(runtime)
    ensure_runtime_directories(runtime)
    return runtime


def _is_port_in_use(port: int) -> bool:
    """Return True if something is listening on the given port."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        return s.connect_ex(("127.0.0.1", port)) == 0


def _kill_station_process(port: int = STATION_PORT) -> tuple[bool, str]:
    """Kill the process listening on the Station Engine port. Returns (success, message)."""
    return stop_daemon_process(port)


def _run_legacy_daemon(args: argparse.Namespace) -> None:
    runtime = _build_runtime_config(args, desktop_defaults=False)
    console.print("[bold green]Soundsible Daemon is running.[/bold green]")
    from shared.api import start_api

    def _handle_exit(*_: object) -> None:
        raise SystemExit(0)

    signal.signal(signal.SIGINT, _handle_exit)
    signal.signal(signal.SIGTERM, _handle_exit)

    try:
        start_api(host=runtime.host, port=runtime.port, runtime_config=runtime)
    except (KeyboardInterrupt, SystemExit):
        console.print("[yellow]Shutting down...[/yellow]")


def _desktop_readiness_payload(runtime: RuntimeConfig) -> dict:
    return {
        "event": "ready",
        "base_url": f"http://{runtime.host}:{runtime.port}",
        "host": runtime.host,
        "port": runtime.port,
        "pid": os.getpid(),
        "version": os.getenv("SOUNDSIBLE_VERSION", "0.0.0-dev"),
        "health": "/api/health",
        "owner_token_file": str(runtime.owner_token_file) if runtime.owner_token_file else None,
    }


def _run_desktop_engine(args: argparse.Namespace) -> None:
    runtime = _build_runtime_config(args, desktop_defaults=True)
    runtime, _ = ensure_owner_token(runtime)
    configure_runtime(runtime)

    def _handle_exit(*_: object) -> None:
        clear_runtime_state(runtime)
        raise SystemExit(0)

    signal.signal(signal.SIGINT, _handle_exit)
    signal.signal(signal.SIGTERM, _handle_exit)

    from shared.api import start_api

    def _on_ready(ready_runtime: RuntimeConfig) -> None:
        write_runtime_state(ready_runtime, version=os.getenv("SOUNDSIBLE_VERSION", "0.0.0-dev"))
        print(json.dumps(_desktop_readiness_payload(ready_runtime)), flush=True)

    try:
        start_api(
            host=runtime.host,
            port=runtime.port,
            runtime_config=runtime,
            on_ready=_on_ready,
        )
    finally:
        clear_runtime_state(runtime)


def run_desktop_engine_cli(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    _seed_runtime_env_from_args(args)
    if not args.desktop_engine:
        args.desktop_engine = True
    if not (get_config_dir() / "config.json").exists():
        print(f"Daemon: {MSG_CONFIG_MISSING}")
        print("Start setup first: python3 run.py --setup")
        return 1
    _run_desktop_engine(args)
    return 0


def bootstrap():
    """Unified bootstrap entry point kept for backward compatibility."""
    _ensure_bootstrap_before_gevent()

# Note: Actual launcher CODE
try:
    from rich.console import Console
    from rich.panel import Panel
    from rich.prompt import Prompt
    from rich.table import Table
    from rich.live import Live
except ImportError:
    print("Error: 'rich' library not found even after bootstrap.")
    sys.exit(1)

console = Console()

class SoundsibleLauncher:
    def __init__(self):
        self.os_name = platform.system()
        self.root_dir = ROOT_DIR
        self.venv_dir = VENV_DIR
        self.python_exe = PYTHON_EXE
        self.child_processes = []
        
        # Note: Register cleanup handler
        atexit.register(self.cleanup)
        signal.signal(signal.SIGINT, lambda s, f: sys.exit(0))
        signal.signal(signal.SIGTERM, lambda s, f: sys.exit(0))

        from shared.database import DatabaseManager
        self.db = DatabaseManager()
        self.stats = {"tracks": 0, "local": 0, "cloud": 0}
        self.sync_status = "Idle"
        self._load_stats()
        self.watcher = None
        self._start_watcher()
        
    def cleanup(self):
        """Force kill all child processes and clean up resources on exit."""
        # Note: Check for API observer in daemon mode
        api_observer_ref = None
        try:
            from shared.api import api_observer
            api_observer_ref = api_observer
        except:
            pass
        
        has_work = bool(self.child_processes) or api_observer_ref is not None
        
        if has_work:
            console.print("\n[dim]Cleaning up background services...[/dim]")
        
        # Note: Clean up child processes
        for proc in self.child_processes:
            try:
                if platform.system() != "Windows":
                    os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
                else:
                    proc.terminate()
            except:
                try: proc.kill()
                except: pass
        
        # Note: Stop API observer if running in daemon mode
        if api_observer_ref is not None:
            try:
                api_observer_ref.stop()
                api_observer_ref.join(timeout=2)
            except:
                pass
        
        # Note: Final safety check kill anything on station engine port
        try:
            _kill_station_process(STATION_PORT)
        except Exception:
            pass

    def _start_watcher(self):
        """Initialize and start the background file watcher."""
        if not _config_path().exists():
            return
        
        def _run():
            try:
                from player.library import LibraryManager
                from setup_tool.watcher import LibraryWatcher
                lib = LibraryManager(silent=True)
                if lib.config and lib.config.watch_folders:
                    self.watcher = LibraryWatcher(lib.config)
                    self.watcher.start()
            except: pass
            
        threading.Thread(target=_run, daemon=True).start()
        
    def _load_stats(self):
        """Load library stats from SQLite database."""
        try:
            self.stats = self.db.get_stats()
        except: pass

    def is_configured(self):
        return _config_path().exists()

    def start_background_sync(self):
        """Run a silent sync in the background."""
        if not self.is_configured():
            return
            
        def _sync():
            time.sleep(1.0)
            self.sync_status = "Syncing..."
            try:
                from player.library import LibraryManager
                lib = LibraryManager(silent=True)
                if lib.sync_library(silent=True):
                    self.stats = self.db.get_stats()
                    self.sync_status = "Synced"
                else:
                    self.sync_status = "Sync Failed"
            except:
                self.sync_status = "Sync Error"
        
        threading.Thread(target=_sync, daemon=True).start()

    def show_menu(self):
        """Display the main TUI menu."""
        console.clear()
        
        stats_line = f"[dim]Library: {self.stats.get('tracks', 0)} tracks ({self.stats.get('local', 0)} local) | Sync: {self.sync_status}[/dim]"
        
        banner = Panel.fit(
            "[bold cyan]SOUNDSIBLE[/bold cyan] [white]Universal Media Ecosystem[/white]\n"
            f"{stats_line}",
            border_style="cyan"
        )
        console.print(banner)

        table = Table(show_header=False, box=None)
        table.add_column("Key", style="bold magenta")
        table.add_column("Option", style="white")

        table.add_row("1", "Start Station Engine & Open Station")
        table.add_row("2", "Start Station Engine only (no browser)")
        table.add_row("3", "Open Station (Station Engine must be running)")
        table.add_row("4", "Stop Station Engine")
        table.add_row("5", "Quick Discover / Terminal Playback")
        table.add_row("6", "Setup storage / configuration")
        table.add_row("q", "Exit")

        console.print(Panel(table, title="Main Menu", border_style="dim"))

        choice = Prompt.ask("[bold cyan]>[/bold cyan] Select an option", choices=["1", "2", "3", "4", "5", "6", "q"], default="1")
        
        if choice == "1":
            self.launch_ecosystem()
        elif choice == "2":
            self.launch_station_only()
        elif choice == "3":
            self.launch_web_player()
        elif choice == "4":
            self.stop_station()
        elif choice == "5":
            self.search_ui()
        elif choice == "6":
            self.launch_setup()
        elif choice == "q":
            console.print("[italic]Happy listening![/italic]")
            sys.exit(0)

    def _print_setup_access(self):
        console.print(Panel.fit(
            "[bold yellow]Configuration is required before the Station Engine can start.[/bold yellow]\n\n"
            f"Setup UI: [cyan]{SETUP_URL}[/cyan]\n\n"
            "On a remote VPS, either use an SSH tunnel:\n"
            f"[yellow]ssh -L {LAUNCHER_PORT}:localhost:{LAUNCHER_PORT} root@YOUR_SERVER[/yellow]\n"
            f"then open [cyan]{SETUP_URL}[/cyan]\n\n"
            "or intentionally bind the launcher to the network:\n"
            "[yellow]SOUNDSIBLE_LAUNCHER_BIND_ALL=true python3 run.py --setup[/yellow]",
            border_style="yellow"
        ))

    def launch_setup(self):
        """Run the setup web UI that writes ~/.config/soundsible/config.json."""
        self._print_setup_access()
        from launcher_web.server import start_server
        start_server(port=LAUNCHER_PORT)

    def launch_ecosystem(self):
        """Start the Station Engine and open the Station (web player) in the browser."""
        console.print("[bold green]Starting Station Engine...[/bold green]")
        ok, msg = start_daemon_process(self.root_dir)
        if not ok:
            if msg == MSG_SETUP_REQUIRED:
                self.launch_setup()
            elif "already running" in msg.lower():
                console.print(f"[green]{msg}[/green]")
                webbrowser.open(PLAYER_URL)
            else:
                console.print(f"[red]{msg}[/red]")
                Prompt.ask("Press Enter to return")
            return
        console.print(Panel.fit(
            "[bold green]Station Engine started. Station opened in browser.[/bold green]\n\n"
            "[bold]" + MSG_KEEP_TERMINAL_OPEN + "[/bold]",
            border_style="green"
        ))
        time.sleep(1.5)
        webbrowser.open(PLAYER_URL)

    def launch_station_only(self):
        """Start the Station Engine (API + sync + watcher) without opening the browser."""
        console.print("[bold green]Starting Station Engine...[/bold green]")
        ok, msg = start_daemon_process(self.root_dir)
        if not ok:
            if msg == MSG_SETUP_REQUIRED:
                self.launch_setup()
            elif "already running" in msg.lower():
                console.print(f"[green]{msg}[/green]")
            else:
                console.print(f"[red]{msg}[/red]")
                Prompt.ask("Press Enter to return")
            return
        console.print(Panel.fit(
            "[bold green]Station Engine started.[/bold green]\n\n"
            "[bold]" + MSG_KEEP_TERMINAL_OPEN + "[/bold]\n\n"
            f"[dim]Open the Station at {PLAYER_URL} when ready.[/dim]",
            border_style="green"
        ))
        time.sleep(0.5)

    def stop_station(self):
        """Kill the process listening on the Station Engine port."""
        ok, msg = stop_daemon_process(STATION_PORT)
        if ok:
            console.print(f"[green]{msg}[/green]")
        else:
            console.print(f"[red]{msg}[/red]")
        time.sleep(0.5)

    def launch_web_player(self):
        """Open the Station (web player) in the default browser (Station Engine must already be running)."""
        if not _is_port_in_use(STATION_PORT):
            console.print("[yellow]Station Engine not running. Use option 1 or 2 to start it.[/yellow]")
            time.sleep(1.0)
            return
        webbrowser.open(PLAYER_URL)
        console.print("[green]Station opened in browser.[/green]")
        time.sleep(0.5)

    def search_ui(self):
        """Interactive search TUI using high-speed SQLite."""
        query = Prompt.ask("[bold magenta]Search Library[/bold magenta]")
        if not query: return
        try:
            results = self.db.search_tracks(query)
            if not results:
                console.print("[yellow]No tracks found.[/yellow]")
            else:
                table = Table(title=f"Results for '{query}'")
                table.add_column("#", style="dim")
                table.add_column("Title", style="green")
                table.add_column("Artist", style="cyan")
                table.add_column("Album", style="yellow")
                for i, t in enumerate(results[:20]):
                    table.add_row(str(i+1), t.title, t.artist, t.album)
                console.print(table)
        except Exception as e:
            console.print(f"[red]Search failed: {e}[/red]")
        Prompt.ask("Press Enter to return")

    def run(self, args: argparse.Namespace):
        self._install_requirements_if_needed()

        if args.setup:
            self.launch_setup()
            return
        
        if not self.is_configured():
            if args.daemon or args.desktop_engine:
                print(f"Daemon: {MSG_CONFIG_MISSING}")
                print("Start setup first: python3 run.py --setup")
                return
            self.launch_setup()
            return
        
        self.start_background_sync()
        self._start_watcher()
        
        if args.daemon:
            runtime = _build_runtime_config(args, desktop_defaults=False)
            console.print("[bold green]Soundsible Daemon is running.[/bold green]")
            from shared.api import start_api
            start_api(host=runtime.host, port=runtime.port, runtime_config=runtime)
            return

        if args.desktop_engine:
            runtime = _build_runtime_config(args, desktop_defaults=True)
            console.print(f"[bold green]Soundsible Desktop Engine is running on {runtime.host}:{runtime.port}.[/bold green]")
            from shared.api import start_api
            start_api(host=runtime.host, port=runtime.port, runtime_config=runtime)
            return

        while True:
            self.show_menu()

    def _install_requirements_if_needed(self):
        _ensure_bootstrap_before_gevent()

if __name__ == "__main__":
    args = build_parser().parse_args()
    _build_runtime_config(args, desktop_defaults=args.desktop_engine)
    if args.desktop_engine:
        raise SystemExit(run_desktop_engine_cli(sys.argv[1:]))
    if args.daemon:
        if not (get_config_dir() / "config.json").exists():
            print(f"Daemon: {MSG_CONFIG_MISSING}")
            print("Start setup first: python3 run.py --setup")
            raise SystemExit(1)
        _run_legacy_daemon(args)
        raise SystemExit(0)
    launcher = SoundsibleLauncher()
    launcher.run(args)
