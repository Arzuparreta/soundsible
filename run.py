#!/usr/bin/env python3
"""
Soundsible Universal Launcher
The single entry point for all Soundsible components (Player, Downloader, Setup).
"""

import os
import sys
import subprocess
import platform
import shutil
import threading
import time
import json
import atexit
import signal
from datetime import datetime
from pathlib import Path

# --- VENV BOOTSTRAP ---
ROOT_DIR = Path(__file__).parent.absolute()
VENV_DIR = ROOT_DIR / "venv"
PYTHON_EXE = VENV_DIR / ("Scripts\\python.exe" if platform.system() == "Windows" else "bin/python")
CONFIG_PATH = Path("~/.config/soundsible/config.json").expanduser()

def bootstrap():
    """Ensure we are running inside the virtual environment."""
    if not VENV_DIR.exists():
        print("Creating virtual environment...")
        subprocess.check_call([sys.executable, "-m", "venv", str(VENV_DIR)])
        
    # Instead of re-executing, we can "activate" the venv in-process for the initial setup
    venv_site_packages = VENV_DIR / ("Lib/site-packages" if platform.system() == "Windows" else f"lib/python{sys.version_info.major}.{sys.version_info.minor}/site-packages")
    
    if str(venv_site_packages) not in sys.path:
        import site
        site.addsitedir(str(venv_site_packages))
        
    # Install basic deps if missing
    try:
        import rich
        import requests
    except ImportError:
        print("Installing core dependencies (rich, requests)...")
        subprocess.check_call([str(PYTHON_EXE), "-m", "pip", "install", "rich", "requests"], 
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

if __name__ == "__main__":
    bootstrap()
    # Now we can safely import rich and start the launcher logic in the same process

# --- ACTUAL LAUNCHER CODE ---
try:
    from rich.console import Console
    from rich.panel import Panel
    from rich.prompt import Prompt
    from rich.table import Table
    from rich.live import Live
    from rich.text import Text
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
        
        # Register cleanup handler
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
        # Check for API observer in daemon mode
        api_observer_ref = None
        try:
            from shared.api import api_observer
            api_observer_ref = api_observer
        except:
            pass
        
        has_work = bool(self.child_processes) or api_observer_ref is not None
        
        if has_work:
            console.print("\n[dim]Cleaning up background services...[/dim]")
        
        # Clean up child processes
        for proc in self.child_processes:
            try:
                if platform.system() != "Windows":
                    os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
                else:
                    proc.terminate()
            except:
                try: proc.kill()
                except: pass
        
        # Stop API Observer if running in daemon mode
        if api_observer_ref is not None:
            try:
                api_observer_ref.stop()
                api_observer_ref.join(timeout=2)
            except:
                pass
        
        # Final safety check: kill anything on port 5005 (always run this)
        try:
            if self.os_name == "Linux":
                subprocess.run(["fuser", "-k", "5005/tcp"], stderr=subprocess.DEVNULL, stdout=subprocess.DEVNULL)
        except: pass

    def _start_watcher(self):
        """Initialize and start the background file watcher."""
        if not CONFIG_PATH.exists(): return
        
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
        return CONFIG_PATH.exists()

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

        table.add_row("1", "Launch Ecosystem (API + sync + watcher)")
        table.add_row("2", "Launch Main App (Station / Web Player)")
        table.add_row("3", "Launch Legacy App (GTK desktop player)")
        table.add_row("4", "Quick Discover / Terminal Playback")
        table.add_row("q", "Exit")

        console.print(Panel(table, title="Main Menu", border_style="dim"))

        choice = Prompt.ask("[bold cyan]>[/bold cyan] Select an option", choices=["1", "2", "3", "4", "q"], default="1")
        
        if choice == "1":
            self.launch_ecosystem()
        elif choice == "2":
            self.launch_web_player()
        elif choice == "3":
            self.launch_player()
        elif choice == "4":
            self.search_ui()
        elif choice == "q":
            console.print("[italic]Happy listening![/italic]")
            sys.exit(0)

    def launch_ecosystem(self):
        """Start the daemon (API + sync + watcher) in a background subprocess."""
        console.print("[bold green]Launching Ecosystem...[/bold green]")
        try:
            log_dir = self.root_dir / "logs"
            log_dir.mkdir(exist_ok=True)
            log_file = open(log_dir / "daemon.log", "a")
            env = os.environ.copy()
            env["PYTHONPATH"] = str(self.root_dir)
            if platform.system() == "Windows":
                popen_args = {"env": env, "cwd": str(self.root_dir), "creationflags": 0x00000010}
            else:
                popen_args = {
                    "stdout": log_file,
                    "stderr": log_file,
                    "env": env,
                    "cwd": str(self.root_dir),
                    "start_new_session": True,
                }
            subprocess.Popen([str(self.python_exe), str(self.root_dir / "run.py"), "--daemon"], **popen_args)
            console.print(Panel.fit(
                "[bold green]Ecosystem is starting.[/bold green]\n\n"
                "Station: [bold cyan]http://localhost:5005/player/[/bold cyan]\n\n"
                "[dim]Logs: logs/daemon.log[/dim]",
                border_style="green"
            ))
            time.sleep(1.5)
        except Exception as e:
            console.print(f"[red]Error: {e}[/red]")

    def launch_player(self):
        """Launch the Legacy GTK desktop player."""
        console.print("[green]Launching Legacy Player...[/green]")
        if self.os_name == "Linux":
            try:
                log_dir = self.root_dir / "logs"
                log_dir.mkdir(exist_ok=True)
                player_log = open(log_dir / "player.log", "a")
                
                proc = subprocess.Popen(
                    [str(self.python_exe), "-c", "from player.ui import run; run()"],
                    cwd=str(self.root_dir),
                    stdout=player_log,
                    stderr=player_log,
                    start_new_session=True 
                )
                self.child_processes.append(proc)
                console.print("[dim]Player is starting. Logs: logs/player.log[/dim]")
                time.sleep(1.0)
            except Exception as e:
                console.print(f"[red]Failed to launch: {e}[/red]")
        else:
            console.print("[yellow]GTK Player is Linux-only. Use Option 3 for Windows.[/yellow]")
            Prompt.ask("Press Enter to return")

    def launch_web_player(self):
        """Launch the Web Player (PWA) interface in background."""
        console.print("[cyan]Starting Web Player Host...[/cyan]")
        try:
            log_dir = self.root_dir / "logs"
            log_dir.mkdir(exist_ok=True)
            log_file = open(log_dir / "api.log", "a")
            
            # Prepare environment to ensure venv and root are in path
            env = os.environ.copy()
            env["PYTHONPATH"] = str(self.root_dir)
            
            # On Windows, we want the output in the new console window for visibility
            if platform.system() == "Windows":
                popen_args = {
                    "env": env,
                    "cwd": str(self.root_dir),
                    "creationflags": 0x00000010 # CREATE_NEW_CONSOLE
                }
            else:
                popen_args = {
                    "stdout": log_file,
                    "stderr": log_file,
                    "env": env,
                    "cwd": str(self.root_dir),
                    "start_new_session": True
                }

            proc = subprocess.Popen([str(self.python_exe), "-m", "shared.api"], **popen_args)
            self.child_processes.append(proc)
            
            # Detect IPs for display
            from shared.api import get_active_endpoints
            endpoints = get_active_endpoints()
            local_ip = endpoints[0] if endpoints else "localhost"
            
            console.print(Panel.fit(
                f"[bold green]Web Player is ONLINE![/bold green]\n\n"
                f"Local: [bold cyan]http://localhost:5005/player/[/bold cyan]\n"
                f"Mobile: [bold cyan]http://{local_ip}:5005/player/[/bold cyan]\n\n"
                "[dim]Server is running in a new window. You can minimize it.[/dim]",
                border_style="green"
            ))
            time.sleep(2.0)
        except Exception as e:
            console.print(f"[red]Error: {e}[/red]")

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

    def run(self):
        self._install_requirements_if_needed()
        
        # Windows-specific entry point
        if os.name == 'nt':
            try:
                from player.ui.windows_ui import WindowsControlCenter
                app = WindowsControlCenter(self)
                app.run()
                return
            except Exception as e:
                console.print(f"[yellow]Note: Windows Control Center could not start ({e}). Falling back to CLI.[/yellow]")

        if not self.is_configured():
            if "--daemon" in sys.argv:
                print("Daemon: Configuration missing. Please run 'run.py' manually first.")
                return
            console.print(Panel("[bold yellow]First Run Detected![/bold yellow]\nWelcome! Launching setup...", border_style="yellow"))
            self.launch_player()
        
        self.start_background_sync()
        self._start_watcher()
        
        if "--daemon" in sys.argv:
            console.print("[bold green]Soundsible Daemon is running.[/bold green]")
            from shared.api import start_api
            start_api()  # This blocks, but api_observer is set as module-level variable
            return

        while True:
            self.show_menu()

    def _install_requirements_if_needed(self):
        req_file = self.root_dir / "requirements.txt"
        marker = self.venv_dir / ".installed_requirements_hash"
        if req_file.exists():
            import hashlib
            current_hash = hashlib.md5(req_file.read_bytes()).hexdigest()
            if not marker.exists() or marker.read_text() != current_hash:
                console.print("[cyan]Installing/Updating requirements...[/cyan]")
                result = subprocess.run([str(self.python_exe), "-m", "pip", "install", "-r", str(req_file)],
                                      capture_output=True, text=True)
                
                if result.returncode != 0:
                    error_panel = Panel(
                        Text.from_markup(f"[bold red]Requirement Installation Failed![/bold red]\n\n"
                                         f"[yellow]Command:[/yellow] {' '.join(result.args)}\n\n"
                                         f"[bold white]Error Output:[/bold white]\n{result.stderr}"),
                        title="Bootstrap Error",
                        border_style="red"
                    )
                    console.print(error_panel)
                    sys.exit(1)
                    
                marker.write_text(current_hash)

if __name__ == "__main__":
    launcher = SoundsibleLauncher()
    launcher.run()
