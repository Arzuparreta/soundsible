"""
Music Folder Watcher.
Monitors configured directories and triggers the scanner on changes.
"""

import time
import threading
from pathlib import Path
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler
from setup_tool.scanner import LibraryScanner
from shared.models import PlayerConfig

class MusicFolderHandler(FileSystemEventHandler):
    def __init__(self, scanner: LibraryScanner):
        self.scanner = scanner
        self.debounce_timer = None
        self.debounce_delay = 5.0 # Seconds to wait after last event before scanning

    def on_modified(self, event):
        if not event.is_directory and self._is_audio(event.src_path):
            self._trigger_scan(Path(event.src_path).parent)

    def on_created(self, event):
        if not event.is_directory and self._is_audio(event.src_path):
            self._trigger_scan(Path(event.src_path).parent)

    def _is_audio(self, path: str) -> bool:
        from setup_tool.audio import AudioProcessor
        return AudioProcessor.is_supported_format(path)

    def _trigger_scan(self, path: Path):
        """Trigger scan with debouncing to avoid multiple hits for one folder move."""
        if self.debounce_timer:
            self.debounce_timer.cancel()
        
        def run_scan():
            print(f"Watcher: Changes detected in {path}. Scanning...")
            self.scanner.scan(str(path))
            
        self.debounce_timer = threading.Timer(self.debounce_delay, run_scan)
        self.debounce_timer.start()

class LibraryWatcher:
    def __init__(self, config: PlayerConfig):
        self.config = config
        self.scanner = LibraryScanner(config)
        self.observer = Observer()
        self.handler = MusicFolderHandler(self.scanner)

    def start(self):
        """Start monitoring all configured folders."""
        watched_count = 0
        for folder in self.config.watch_folders:
            path = Path(folder).expanduser().resolve()
            if path.exists():
                self.observer.schedule(self.handler, str(path), recursive=True)
                watched_count += 1
        
        if watched_count > 0:
            print(f"Watcher: Monitoring {watched_count} directories.")
            self.observer.start()
        else:
            print("Watcher: No valid directories to monitor.")

    def stop(self):
        self.observer.stop()
        self.observer.join()
