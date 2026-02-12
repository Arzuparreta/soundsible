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
        print(f"Creating virtual environment in {VENV_DIR}...")
        subprocess.check_call([sys.executable, "-m", "venv", str(VENV_DIR)])
        
    # Check if we are already running from the venv
    if sys.executable != str(PYTHON_EXE.resolve()):
        # Install basic deps in venv if not present
        subprocess.check_call([str(PYTHON_EXE), "-m", "pip", "install", "rich", "requests"])
        
        # Re-run this script using the venv python
        os.execv(str(PYTHON_EXE), [str(PYTHON_EXE)] + sys.argv)

if __name__ == "__main__" and "BOOTSTRAPPED" not in os.environ:
    # Check for daemon flag before bootstrapping to avoid recursion loops if not careful
    # But usually we WANT the venv python for the daemon too.
    if "--daemon" in sys.argv:
        os.environ["BOOTSTRAPPED"] = "1"
        bootstrap()
    else:
        os.environ["BOOTSTRAPPED"] = "1"
        bootstrap()

# --- ACTUAL LAUNCHER CODE ---
try:
    from rich.console import Console
    from rich.panel import Panel
    from rich.prompt import Prompt
    from rich.table import Table
    from rich.live import Live
    from rich.text import Text
except ImportError:
    # This should not happen after bootstrap
    print("Error: 'rich' library not found even after bootstrap.")
    sys.exit(1)

console = Console()

class SoundsibleLauncher:
    def __init__(self):
        self.os_name = platform.system()
        self.root_dir = ROOT_DIR
        self.venv_dir = VENV_DIR
        self.python_exe = PYTHON_EXE
        from shared.database import DatabaseManager
        self.db = DatabaseManager()
        self.stats = {"tracks": 0, "local": 0, "cloud": 0}
        self.sync_status = "Idle"
        self._load_stats()
        self.watcher = None
        self._start_watcher()
        
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
            # Wait for TUI to render first frame
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

        table.add_row("1", "Launch Music Player (GUI) [bold green](Recommended)[/bold green]")
        table.add_row("2", "Launch Music Downloader (ODST Web UI)")
        table.add_row("3", "Search Library (Quick Discover)")
        table.add_row("4", "Manage Storage / Sync")
        table.add_row("5", "Advanced Options")
        table.add_row("q", "Quit")

        console.print(Panel(table, title="Main Menu", border_style="dim"))

        choice = Prompt.ask("[bold cyan]>[/bold cyan] Select an option", choices=["1", "2", "3", "4", "5", "q"], default="1")
        
        if choice == "1":
            self.launch_player()
        elif choice == "2":
            self.launch_downloader()
        elif choice == "3":
            self.search_ui()
        elif choice == "4":
            self.manage_storage()
        elif choice == "5":
            self.show_advanced_menu()
        elif choice == "q":
            console.print("[italic]Happy listening![/italic]")
            sys.exit(0)

    def show_advanced_menu(self):
        """Advanced tools and CLI configuration."""
        console.clear()
        console.print(Panel("[bold red]Advanced Options[/bold red]\n[dim]Use these tools for deep maintenance or CLI-based setup.[/dim]", border_style="red"))
        
        table = Table(show_header=False, box=None)
        table.add_column("Key", style="bold magenta")
        table.add_column("Option", style="white")
        table.add_row("1", "Run CLI Setup Wizard (Guided)")
        table.add_row("2", "Launch Core API Server")
        table.add_row("3", "System Integrity Check")
        table.add_row("b", "Back to Main Menu")
        
        console.print(Panel(table, border_style="dim"))
        choice = Prompt.ask("Select an option", choices=["1", "2", "3", "b"], default="b")
        
        if choice == "1":
            self.launch_setup()
        elif choice == "2":
            self.launch_api()
        elif choice == "3":
            subprocess.run([str(self.python_exe), "-m", "setup_tool.cli", "cleanup"])
            Prompt.ask("Press Enter to continue")
        
    def search_ui(self):
        """Interactive search TUI using high-speed SQLite."""
        query = Prompt.ask("[bold magenta]Search Library[/bold magenta]")
        if not query: return
        
        console.print(f"[cyan]Searching for: {query}...[/cyan]")
        
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
                table.add_column("Source", style="dim")
                
                for i, t in enumerate(results[:20]):
                    source = "Local" if t.is_local else "Cloud"
                    table.add_row(str(i+1), t.title, t.artist, t.album, source)
                
                console.print(table)
                if len(results) > 20:
                    console.print(f"[dim]... and {len(results)-20} more.[/dim]")
        except Exception as e:
            console.print(f"[red]Search failed: {e}[/red]")
            
        Prompt.ask("Press Enter to return to menu")

    def launch_player(self):
        """Launch the Music Player component."""
        console.print("[green]Launching Soundsible Player...[/green]")
        if self.os_name == "Linux":
            # Check for GTK dependencies on Linux
            try:
                log_dir = self.root_dir / "logs"
                log_dir.mkdir(exist_ok=True)
                log_file = open(log_dir / "player.log", "a")
                
                subprocess.Popen(
                    [str(self.python_exe), "-c", "from player.ui import run; run()"],
                    stdout=log_file,
                    stderr=log_file
                )
            except Exception as e:
                console.print(f"[red]Failed to launch GTK player: {e}[/red]")
                console.print("[yellow]Hint: Ensure libadwaita and python-gobject are installed.[/yellow]")
        else:
            console.print("[yellow]GTK Player is currently Linux-only. We are working on the Tauri port for Windows![/yellow]")
            Prompt.ask("Press Enter to return to menu")

    def launch_downloader(self):
        """Launch the ODST Web Downloader."""
        console.print("[green]Starting ODST Web Interface...[/green]")
        try:
            log_dir = self.root_dir / "logs"
            log_dir.mkdir(exist_ok=True)
            log_file = open(log_dir / "downloader.log", "a")
            
            # Run as module from root to support relative imports
            subprocess.Popen(
                [str(self.python_exe), "-m", "odst_tool.web_app"],
                stdout=log_file,
                stderr=log_file
            )
            console.print("[bold green]ODST Web UI is running at http://localhost:5000[/bold green]")
            Prompt.ask("Press Enter to return to menu (this will NOT stop the server)")
        except Exception as e:
            console.print(f"[red]Error: {e}[/red]")

    def launch_setup(self):
        """Run the setup wizard."""
        console.print("[cyan]Starting Setup Wizard...[/cyan]")
        subprocess.run([str(self.python_exe), "-m", "setup_tool.cli", "init", "--guided"])
        # Reload stats after setup
        self._load_stats()
        if not "BOOTSTRAPPED" in os.environ: # If called from run() onboarding
             Prompt.ask("Setup complete. Press Enter to enter Main Menu")

    def launch_api(self):
        """Launch the Core API Server."""
        console.print("[bold green]Starting Soundsible Core API...[/bold green]")
        try:
            log_dir = self.root_dir / "logs"
            log_dir.mkdir(exist_ok=True)
            log_file = open(log_dir / "api.log", "a")
            
            # Run as module from root
            subprocess.Popen([str(self.python_exe), "-m", "shared.api"],
                             stdout=log_file,
                             stderr=log_file)
            console.print("[bold green]API Server is running on http://localhost:5005[/bold green]")
            Prompt.ask("Press Enter to return to menu")
        except Exception as e:
            console.print(f"[red]Error: {e}[/red]")

    def manage_storage(self):
        """Storage management submenu."""
        console.print("[bold yellow]Storage Management[/bold yellow]")
        table = Table(show_header=False, box=None)
        table.add_column("Key", style="bold magenta")
        table.add_column("Option", style="white")
        table.add_row("1", "Manual Sync")
        table.add_row("2", "Deep Scan Folder")
        table.add_row("3", "Cleanup/Janitor")
        table.add_row("4", "Config Management")
        table.add_row("5", "Watch Folders (Auto-Scan)")
        table.add_row("6", "[bold yellow]Disconnect Storage (Reset)[/bold yellow]")
        table.add_row("9", "[bold red]DELETE ALL CONTENT (Nuke)[/bold red]")
        table.add_row("b", "Back")
        
        console.print(Panel(table, border_style="dim"))
        choice = Prompt.ask("Choose an action", choices=["1", "2", "3", "4", "5", "6", "9", "b"], default="b")
        
        if choice == "1":
            from player.library import LibraryManager
            lib = LibraryManager()
            lib.sync_library()
            self._load_stats()
            Prompt.ask("Press Enter")
        elif choice == "2":
            path = Prompt.ask("Enter music path", default=str(Path.home() / "Music"))
            subprocess.run([str(self.python_exe), "-m", "setup_tool.cli", "scan", path])
            self._load_stats()
            Prompt.ask("Press Enter")
        elif choice == "3":
            subprocess.run([str(self.python_exe), "-m", "setup_tool.cli", "cleanup"])
            Prompt.ask("Press Enter")
        elif choice == "4":
             console.print("1. Export Config (QR)")
             console.print("2. Import Config (Token)")
             sub = Prompt.ask("Action", choices=["1", "2", "b"], default="b")
             if sub == "1":
                 subprocess.run([str(self.python_exe), "-m", "setup_tool.cli", "export-config"])
             elif sub == "2":
                 token = Prompt.ask("Enter token")
                 subprocess.run([str(self.python_exe), "-m", "setup_tool.cli", "import-config", token])
             Prompt.ask("Press Enter")
        elif choice == "5":
            self.manage_watch_folders()
        elif choice == "6":
             from rich.prompt import Confirm
             if Confirm.ask("Disconnect from current cloud service? (Your files in the cloud will be safe)"):
                 wipe = Confirm.ask("Also wipe local library metadata and cache? (Clean start)")
                 from player.library import LibraryManager
                 lib = LibraryManager()
                 if lib.disconnect_storage(wipe_local=wipe):
                     self._load_stats()
                     console.print("[green]Disconnected. Restart the app to run setup again.[/green]")
                 else:
                     console.print("[red]Failed to disconnect.[/red]")
             Prompt.ask("Press Enter")
        elif choice == "9":
            from rich.prompt import Confirm
            if Confirm.ask("[bold red]ARE YOU SURE?[/bold red] This will permanently delete ALL tracks from cloud and local cache!"):
                from player.library import LibraryManager
                lib = LibraryManager()
                if lib.nuke_library():
                    self._load_stats()
                    console.print("[bold green]Library has been wiped clean.[/bold green]")
                else:
                    console.print("[bold red]Failed to fully wipe library.[/bold red]")
                Prompt.ask("Press Enter")
        elif choice == "b":
            pass

    def manage_watch_folders(self):
        """Configure which folders are monitored for changes."""
        from player.library import LibraryManager
        lib = LibraryManager()
        if not lib.config: return
        
        console.print("[bold cyan]Currently Watched Folders:[/bold cyan]")
        if not lib.config.watch_folders:
            console.print("  None")
        else:
            for f in lib.config.watch_folders:
                console.print(f"  - {f}")
        
        action = Prompt.ask("\n[bold]Action[/bold]", choices=["a", "c", "b"], default="b", 
                            show_choices=False) # a=Add, c=Clear, b=Back
        console.print("(a) Add Folder  (c) Clear All  (b) Back")
        
        if action == "a":
            path = Prompt.ask("Enter folder path to watch")
            if os.path.exists(path):
                if path not in lib.config.watch_folders:
                    lib.config.watch_folders.append(path)
                    # Save config
                    with open(CONFIG_PATH, 'w') as f:
                        f.write(lib.config.to_json())
                    console.print("[green]Folder added. Restart launcher to start watching.[/green]")
            else:
                console.print("[red]Path does not exist.[/red]")
        elif action == "c":
            lib.config.watch_folders = []
            with open(CONFIG_PATH, 'w') as f:
                f.write(lib.config.to_json())
            console.print("[yellow]Watch folders cleared.[/yellow]")
            
        Prompt.ask("Press Enter")


    def run(self):
        self._install_requirements_if_needed()
        
        # 1. Onboarding
        if not self.is_configured():
            if "--daemon" in sys.argv:
                print("Daemon: Configuration missing. Please run 'run.py' manually first.")
                return
            console.print(Panel("[bold yellow]First Run Detected![/bold yellow]\nWelcome to Soundsible! Launching the setup wizard...", border_style="yellow"))
            self.launch_player()
        
        # 2. Background Sync
        self.start_background_sync()
        
        # 3. Background Watcher
        self._start_watcher()
        
        # 4. Handle Daemon Mode
        if "--daemon" in sys.argv:
            console.print("[bold green]Soundsible Daemon is running.[/bold green]")
            # Start API in same process (blocking)
            from shared.api import start_api
            start_api()
            return

        while True:
            self.show_menu()

    def _install_requirements_if_needed(self):
        """Check and update dependencies."""
        req_file = self.root_dir / "requirements.txt"
        marker = self.venv_dir / ".installed_requirements_hash"
        
        if req_file.exists():
            import hashlib
            current_hash = hashlib.md5(req_file.read_bytes()).hexdigest()
            
            if not marker.exists() or marker.read_text() != current_hash:
                console.print("[cyan]Verifying dependencies...[/cyan]")
                self._install_requirements()
                marker.write_text(current_hash)

    def _install_requirements(self):
        """Install requirements into the venv."""
        req_file = self.root_dir / "requirements.txt"
        if req_file.exists():
            subprocess.check_call([str(self.python_exe), "-m", "pip", "install", "-r", str(req_file)])

if __name__ == "__main__":
    launcher = SoundsibleLauncher()
    launcher.run()
