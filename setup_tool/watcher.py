"""
Music Folder Watcher.
Monitors configured directories and triggers the scanner on changes.
"""

import threading
from pathlib import Path
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler
from shared.models import PlayerConfig

class MusicFolderHandler(FileSystemEventHandler):
    def __init__(self, scan_callback):
        self.scan_callback = scan_callback
        self.debounce_timer = None
        self.debounce_delay = 5.0 # Note: Seconds to wait after last event before scanning

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
            self.scan_callback(str(path))
            
        self.debounce_timer = threading.Timer(self.debounce_delay, run_scan)
        self.debounce_timer.start()

class LibraryWatcher:
    def __init__(self, config: PlayerConfig, *, scan_callback):
        self.config = config
        self.observer = Observer()
        self.handler = MusicFolderHandler(scan_callback)
        self.started = False

    def start(self):
        """Start monitoring all configured folders."""
        from shared.path_resolver import register_scan_roots

        register_scan_roots(self.config.watch_folders)
        watched_count = 0
        for folder in self.config.watch_folders:
            path = Path(folder).expanduser().resolve()
            if path.exists():
                self.observer.schedule(self.handler, str(path), recursive=True)
                watched_count += 1
        
        if watched_count > 0:
            self.observer.start()
            self.started = True
        else:
            pass

    def stop(self):
        if self.started:
            self.observer.stop()
            self.observer.join()
            self.started = False
